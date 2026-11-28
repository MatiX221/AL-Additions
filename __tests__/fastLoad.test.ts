import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { bootModuleForTest, runMigrations } from '../src/core/registry';
import { CoreHooks } from '../src/core/bus';
import { Settings } from '../src/settings/settings';
import { store as gmStore } from '../src/utils/helpers';
import { AniList } from '../src/api/anilist';
import { bootModuleForTest as _boot, disposeFeature, runMigrations as _runMig } from '../src/core/registry';
import {
  setPausedUntil,
  store as flStore,
  rpcCache as flRpcCache,
  userMap as flUserMap,
  idToUserMap as flIdToUserMap,
  pausedUntil as flPausedUntil,
  freshFloor as flFreshFloor
} from '../src/modules/fastLoad/state';
import {
  isTaxonomyQuery,
  isViewerQuery,
  isUnfilteredMediaListVars,
  isUnfilteredMediaListQuery,
  buildQueryCacheKey,
  isRpcBlocked
} from '../src/modules/fastLoad/helpers';
import { makeKey } from '../src/modules/fastLoad/graphql';
import {
  learned,
  loadRoutes,
  initRoutes,
  cleanupRoutes,
  scheduleAutoPrefetch,
  autoPrefetchListsForCurrentRoute,
  prefetchFor
} from '../src/modules/fastLoad/routes';
import {
  rpcKey,
  prefetchWorkerList,
  hookWorker,
  extractUsersFromRpcResult,
  lastAuth as flLastAuth,
  workerUrl as flWorkerUrl
} from '../src/modules/fastLoad/worker';
import {
  installLazyMedia,
  installRowSkipping,
  installObserverCoalescing
} from '../src/modules/fastLoad/domOptimizers';

import '../src/settings/devMode';
import '../src/modules/fastLoad';

describe('FastLoad: GraphQL Performance & Cache Engine', () => {
  let mockNativeFetch = vi.fn();

  function createJsonResponse(data: any, status = 200, statusText = 'OK') {
    return new Response(JSON.stringify(data), {
      status,
      statusText,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 15));

  beforeAll(async () => {
    window.fetch = ((...args: any[]) => mockNativeFetch(...args)) as any;
    (window as any).unsafeWindow = window;

    await bootModuleForTest('fastLoad');
  });

  beforeEach(() => {
    mockNativeFetch.mockReset();
    window.localStorage.clear();
    setPausedUntil(0);
    initRoutes();

    if (typeof (window as any).__ALFL_CLEAR__ === 'function') {
      (window as any).__ALFL_CLEAR__();
    }

    for (const k of gmStore.list()) {
      if (k.includes('taxonomy:') || k === 'ala_mod_fastLoad_rpc:listTpl:v2') {
        gmStore.del(k);
      }
    }

    const stats = (window as any).__ALFL_STATS__;
    if (stats) {
      stats.graphqlRequests = 0;
      stats.cacheHits = 0;
      stats.deduped = 0;
      stats.staleServed = 0;
    }
  });

  describe('Module Initialization & Global Flags', () => {
    it('registers FastLoad version flag and internal inspection hooks', () => {
      expect((window as any).__ALA_FAST_LOAD__).toBe('0.4.3');
      expect((window as any).__ALFL_STATS__).toBeDefined();
      expect(typeof (window as any).__ALFL_CLEAR__).toBe('function');
    });
  });

  describe('Query Normalization & Cache Key Equivalence', () => {
    it('normalizes whitespace, newlines, and comments to serve cache hits', async () => {
      const responseData = { data: { Media: { id: 1, title: { romaji: 'Cowboy Bebop' } } } };
      mockNativeFetch.mockResolvedValueOnce(createJsonResponse(responseData));

      const queryA = 'query MediaList { # fetch media\n Media(id: 1) { id title { romaji } } }';
      const res1 = await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryA })
      });
      const data1 = await res1.json();

      expect(mockNativeFetch).toHaveBeenCalledTimes(1);
      expect(data1).toEqual(responseData);

      await flushAsync();

      const queryB = `
        query MediaList {
          Media( id : 1 ) {
            id
            title {
              romaji
            }
          }
        }
      `;
      const res2 = await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryB })
      });
      const data2 = await res2.json();

      expect(mockNativeFetch).toHaveBeenCalledTimes(1);
      expect(data2).toEqual(responseData);
      expect((window as any).__ALFL_STATS__.cacheHits).toBe(1);
    });

    it('normalizes variable key ordering via stable serialization', async () => {
      const responseData = { data: { Page: { media: [] } } };
      mockNativeFetch.mockResolvedValueOnce(createJsonResponse(responseData));

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query Search($season: MediaSeason, $year: Int) { Page { media { id } } }',
          variables: { season: 'FALL', year: 2024 }
        })
      });

      await flushAsync();
      expect(mockNativeFetch).toHaveBeenCalledTimes(1);

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query Search($season: MediaSeason, $year: Int) { Page { media { id } } }',
          variables: { year: 2024, season: 'FALL' }
        })
      });

      expect(mockNativeFetch).toHaveBeenCalledTimes(1);
      expect((window as any).__ALFL_STATS__.cacheHits).toBe(1);
    });

    it('maps MediaListCollection queries with userName to userId alias', async () => {
      gmStore.set('al_username', 'MatiX');
      gmStore.set('al_user_id', 9999);

      const responseData = { data: { MediaListCollection: { lists: [] } } };
      mockNativeFetch.mockResolvedValueOnce(createJsonResponse(responseData));

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query GetMediaList { MediaListCollection(userName: "MatiX", type: ANIME) { lists { name } } }',
          variables: { userName: 'MatiX', type: 'ANIME' }
        })
      });

      await flushAsync();
      expect(mockNativeFetch).toHaveBeenCalledTimes(1);

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query GetMediaList { MediaListCollection(userId: 9999, type: ANIME) { lists { name } } }',
          variables: { userId: 9999, type: 'ANIME' }
        })
      });

      expect(mockNativeFetch).toHaveBeenCalledTimes(1);
      expect((window as any).__ALFL_STATS__.cacheHits).toBe(1);
    });
  });

  describe('Concurrent Request Deduplication (In-Flight Coalescing)', () => {
    it('coalesces multiple concurrent identical requests into a single network call', async () => {
      let resolveFetch!: (res: Response) => void;
      const pendingPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      mockNativeFetch.mockReturnValue(pendingPromise);

      const requestBody = JSON.stringify({
        query: 'query InflightTest { Viewer { id name } }'
      });

      const req1 = window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });
      const req2 = window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });
      const req3 = window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });

      await flushAsync();
      expect(mockNativeFetch).toHaveBeenCalledTimes(1);

      resolveFetch(createJsonResponse({ data: { Viewer: { id: 100, name: 'Tester' } } }));

      const [res1, res2, res3] = await Promise.all([req1, req2, req3]);
      const [d1, d2, d3] = await Promise.all([res1.json(), res2.json(), res3.json()]);

      expect(d1).toEqual(d2);
      expect(d2).toEqual(d3);
      expect((window as any).__ALFL_STATS__.deduped).toBe(2);
    });
  });

  describe('Cache Invalidation & Epoch Bumping', () => {
    it('clears cache and increments epoch upon executing a GraphQL mutation', async () => {
      const queryData = { data: { Media: { id: 50 } } };
      mockNativeFetch
        .mockResolvedValueOnce(createJsonResponse(queryData))
        .mockResolvedValueOnce(createJsonResponse({ data: { SaveMediaListEntry: { id: 1 } } }))
        .mockResolvedValueOnce(createJsonResponse(queryData));

      const queryBody = JSON.stringify({ query: 'query GetMedia { Media(id: 50) { id } }' });

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: queryBody
      });
      await flushAsync();
      expect(mockNativeFetch).toHaveBeenCalledTimes(1);

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'mutation UpdateListEntry($id: Int) { SaveMediaListEntry(id: $id) { id } }',
          variables: { id: 50 }
        })
      });
      await flushAsync();
      expect(mockNativeFetch).toHaveBeenCalledTimes(2);

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: queryBody
      });
      await flushAsync();
      expect(mockNativeFetch).toHaveBeenCalledTimes(3);
    });

    it('invalidates cache when manually calling __ALFL_CLEAR__', async () => {
      const queryData = { data: { Page: { media: [{ id: 101 }] } } };
      mockNativeFetch
        .mockResolvedValueOnce(createJsonResponse(queryData))
        .mockResolvedValueOnce(createJsonResponse(queryData));

      const queryBody = JSON.stringify({ query: 'query MediaCatalog { Page { media { id } } }' });

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: queryBody
      });
      await flushAsync();
      expect(mockNativeFetch).toHaveBeenCalledTimes(1);

      await new Promise((r) => setTimeout(r, 15));

      (window as any).__ALFL_CLEAR__();

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: queryBody
      });
      await flushAsync();
      expect(mockNativeFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Handling, Volatile Queries & Stale Fallback', () => {
    it('never caches volatile queries such as notifications or activities', async () => {
      mockNativeFetch
        .mockResolvedValueOnce(createJsonResponse({ data: { Activity: { id: 1 } } }))
        .mockResolvedValueOnce(createJsonResponse({ data: { Activity: { id: 1 } } }));

      const volatileBody = JSON.stringify({
        query: 'query GetActivities { Activity(id: 1) { id type } }'
      });

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: volatileBody
      });
      await flushAsync();

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: volatileBody
      });
      await flushAsync();

      expect(mockNativeFetch).toHaveBeenCalledTimes(2);
      expect((window as any).__ALFL_STATS__.cacheHits).toBe(0);
    });

    it('rejects caching responses containing GraphQL syntax or runtime errors', async () => {
      const errorResponse = { errors: [{ message: 'Field does not exist', status: 400 }] };
      mockNativeFetch
        .mockResolvedValueOnce(createJsonResponse(errorResponse, 200))
        .mockResolvedValueOnce(createJsonResponse({ data: { Media: { id: 1 } } }, 200));

      const queryBody = JSON.stringify({ query: 'query ErrorQuery { NonExistentField }' });

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: queryBody
      });
      await flushAsync();

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: queryBody
      });
      await flushAsync();

      expect(mockNativeFetch).toHaveBeenCalledTimes(2);
      expect((window as any).__ALFL_STATS__.cacheHits).toBe(0);
    });

    it('serves stale cached snapshot when network fetch encounters an HTTP 500 error', async () => {
      vi.useFakeTimers();
      const initialData = { data: { Media: { id: 99, title: { romaji: 'Steins;Gate' } } } };

      mockNativeFetch.mockResolvedValueOnce(createJsonResponse(initialData));

      const queryBody = JSON.stringify({ query: 'query StaleTest { Media(id: 99) { id title { romaji } } }' });
      const res1 = await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: queryBody
      });
      expect(await res1.json()).toEqual(initialData);

      await vi.advanceTimersByTimeAsync(20_000);

      mockNativeFetch.mockResolvedValueOnce(createJsonResponse({ error: 'Server down' }, 500, 'Internal Server Error'));

      const res2 = await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: queryBody
      });

      const data2 = await res2.json();
      expect(data2).toEqual(initialData);
      expect((window as any).__ALFL_STATS__.staleServed).toBe(1);

      vi.useRealTimers();
    });

    it('serves MediaListCollection from RPC cache when queried via window.fetch without network request', async () => {
      const rpcCache = (window as any).__ALFL_RPC_CACHE__ as Map<string, any>;
      expect(rpcCache).toBeDefined();

      const gqlStore = (window as any).__ALFL_GQL_STORE__ as Map<string, any>;
      const cachedMlc = {
        user: { id: 7053169, name: 'TargetUser' },
        lists: [
          {
            name: 'Completed',
            isCustomList: false,
            entries: [
              {
                id: 222,
                mediaId: 50,
                status: 'COMPLETED',
                score: 10,
                media: { id: 50, title: { userPreferred: 'Neon Genesis Evangelion' } }
              }
            ]
          }
        ]
      };

      const raw = JSON.stringify({ data: { MediaListCollection: cachedMlc } });
      gqlStore.set('gql:MediaListCollection:ANIME:7053169:{}', {
        time: Date.now(),
        snap: { buf: new TextEncoder().encode(raw).buffer }
      });

      const result = await AniList.getMediaList(7053169, 'ANIME');
      expect(result.allEntries.length).toBe(1);
      expect(result.allEntries[0].mediaId).toBe(50);
      expect(result.allEntries[0].score).toBe(10);
      expect(result.user?.name).toBe('TargetUser');
    });

    it('bypasses cache when noStore is present even for MediaListCollection queries', async () => {
      mockNativeFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { MediaListCollection: { user: { id: 7053169 }, lists: [] } }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          query: 'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { lists { name } } }',
          variables: { userId: 7053169, type: 'ANIME' }
        })
      });

      expect(mockNativeFetch).toHaveBeenCalledTimes(1);
    });

    it('blocks requests in worker hook when __ALFL_RPC_BLOCK__ matches', () => {
      const pageWin = window as any;
      const blocker = vi.fn((_q: string, v: any) => v?.id === 7053169 && Number(v?.page) > 1);
      pageWin.__ALFL_RPC_BLOCK__ = blocker;

      expect(typeof pageWin.__ALFL_RPC_BLOCK__).toBe('function');
      expect(pageWin.__ALFL_RPC_BLOCK__('query', { id: 7053169, page: 2 })).toBe(true);
      expect(pageWin.__ALFL_RPC_BLOCK__('query', { id: 7053169, page: 1 })).toBe(false);
      delete pageWin.__ALFL_RPC_BLOCK__;
    });

    it('blocks requests in cachedFetch when __ALFL_RPC_BLOCK__ matches', async () => {
      const pageWin = window as any;
      const blocker = vi.fn((_q: string, v: any) => v?.id === 7053169 && Number(v?.page) > 1);
      pageWin.__ALFL_RPC_BLOCK__ = blocker;

      mockNativeFetch.mockClear();
      const payload = {
        query: 'query($id:Int,$page:Int){Page(page:$page){mediaList(userId:$id){id}}}',
        variables: { id: 7053169, page: 2 }
      };

      const res = await window.fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      expect(mockNativeFetch).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.Page.pageInfo.hasNextPage).toBe(false);
      expect(json.data.Page.mediaList).toEqual([]);

      delete pageWin.__ALFL_RPC_BLOCK__;
    });

    it('serves MediaListCollection from rpcCache via AniList.getMediaList without network request', async () => {
      const pageWin = window as any;
      const rpcCache = pageWin.__ALFL_RPC_CACHE__ as Map<string, any>;
      mockNativeFetch.mockClear();

      const rpcPayload = {
        entities: {
          mediaListEntry: {
            '1001': { id: 1001, mediaId: 888, status: 'COMPLETED', score: 9.5 }
          },
          media: {
            '888': { id: 888, title: { userPreferred: 'RPC Prefetched Anime' } }
          },
          user: {
            '7053170': { id: 7053170, name: 'TargetUser2' }
          }
        },
        result: 'rpcResult'
      };

      rpcCache.set('rpc:MediaListCollection:ANIME:7053170:{}', {
        time: Date.now(),
        msg: { type: 'RPC', id: '1', result: rpcPayload }
      });

      const res = await AniList.getMediaList(7053170, 'ANIME');
      expect(mockNativeFetch).not.toHaveBeenCalled();
      expect(res.allEntries.length).toBe(1);
      expect(res.allEntries[0].mediaId).toBe(888);
      expect(res.allEntries[0].score).toBe(9.5);
      expect(res.allEntries[0].media?.title?.userPreferred).toBe('RPC Prefetched Anime');
      expect(res.user?.name).toBe('TargetUser2');
    });

    it('serves MediaListCollection from rpcCache via AniList.getMediaList with real normalizr listEntry entity', async () => {
      const pageWin = window as any;
      const rpcCache = pageWin.__ALFL_RPC_CACHE__ as Map<string, any>;
      mockNativeFetch.mockClear();

      const rpcPayload = {
        entities: {
          listEntry: {
            '2001': { id: 2001, mediaId: 999, status: 'PLANNING', score: 0 }
          },
          media: {
            '999': { id: 999, title: { userPreferred: 'Real Worker Normalizr Anime' } }
          },
          user: {
            '7053171': { id: 7053171, name: 'TargetUser3' }
          }
        },
        result: 'rpcResult3'
      };

      rpcCache.set('rpc:MediaListCollection:ANIME:7053171:{}', {
        time: Date.now(),
        msg: { type: 'RPC', id: '2', result: rpcPayload }
      });

      const res = await AniList.getMediaList(7053171, 'ANIME');
      expect(mockNativeFetch).not.toHaveBeenCalled();
      expect(res.allEntries.length).toBe(1);
      expect(res.allEntries[0].mediaId).toBe(999);
      expect(res.allEntries[0].score).toBe(0);
      expect(res.allEntries[0].media?.title?.userPreferred).toBe('Real Worker Normalizr Anime');
      expect(res.user?.name).toBe('TargetUser3');
    });
  });

  describe('Route Learning Isolation & RPC TTL Parity', () => {
    it('ignores internal AniList API requests during route learning and purges stale alfl:routes:v3', async () => {
      window.localStorage.setItem(
        'alfl:routes:v3',
        JSON.stringify({
          'anime/': {
            t: Date.now(),
            id: 1,
            static: false,
            reqs: [{ url: 'https://anilist.co/graphql', body: '{"query":"old"}', headers: {} }]
          }
        })
      );
      gmStore.set('alfl:workerUrl', 'https://anilist.co/old.worker.js');
      gmStore.set('alfl:rpc:listTpl:v2', '{}');
      learned.clear();
      runMigrations();
      loadRoutes();
      expect(window.localStorage.getItem('alfl:routes:v3')).toBeNull();
      expect(gmStore.get('alfl:workerUrl', null)).toBeNull();
      expect(gmStore.get('alfl:rpc:listTpl:v2', null)).toBeNull();
      expect(learned.get('anime/')).toBeUndefined();

      history.replaceState({}, '', '/anime/206949');
      mockNativeFetch.mockResolvedValueOnce(
        createJsonResponse({ data: { Media: { title: { romaji: 'InternalTest' }, seasonYear: 2025 } } })
      );

      await AniList.query(
        'query ($id: Int) { Media(id: $id) { title { userPreferred english romaji native } seasonYear season } }',
        { id: 206949 }
      );
      await flushAsync();
      expect(learned.get('anime/')).toBeUndefined();

      mockNativeFetch.mockResolvedValueOnce(
        createJsonResponse({ data: { Media: { id: 206949 } } })
      );
      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query ($id: Int) { Media(id: $id) { id } }',
          variables: { id: 206949 }
        })
      });
      await flushAsync();
      expect(learned.get('anime/')?.reqs).toHaveLength(1);
    });

    it('retains User profile RPC cache hits past 15s (60s TTL)', async () => {
      vi.useFakeTimers();
      const origWorker = window.Worker;
      const origPostCalls: any[] = [];

      class MockWorker extends EventTarget {
        postMessage(data: any) {
          origPostCalls.push(data);
          setTimeout(() => {
            this.dispatchEvent(
              new MessageEvent('message', {
                data: { type: 'RPC', id: data.id, result: { User: { id: 7053169, name: 'MysticDaiya' } } }
              })
            );
          }, 0);
        }
        terminate() {}
      }

      try {
        (window as any).Worker = MockWorker;
        hookWorker(() => false);

        const worker = new window.Worker('/test.worker.js');
        const payload = {
          type: 'RPC',
          id: 'rpc-1',
          method: 'fetch',
          params: [
            '/graphql',
            'query($id:Int,$name:String){User(id:$id,name:$name){id name}}',
            { name: 'MysticDaiya' },
            {}
          ]
        };

        const responses: any[] = [];
        worker.addEventListener('message', (ev: MessageEvent) => responses.push(ev.data));

        worker.postMessage(payload);
        await vi.advanceTimersByTimeAsync(10);
        expect(origPostCalls).toHaveLength(1);
        expect(responses).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(20_000);
        worker.postMessage({ ...payload, id: 'rpc-2' });
        await vi.advanceTimersByTimeAsync(10);
        expect(origPostCalls).toHaveLength(1);
        expect(responses).toHaveLength(2);
        expect(responses[1].id).toBe('rpc-2');
      } finally {
        (window as any).Worker = origWorker;
        vi.useRealTimers();
      }
    });
  });

  describe('CoreHooks authHeader, Viewer-only recordHint & 2-tier RPC logging', () => {
    it('stores Bearer header via CoreHooks.setAuthHeader and ignores non-Viewer users in extractUsersFromRpcResult', async () => {
      CoreHooks.clearAuth();
      mockNativeFetch.mockResolvedValueOnce(createJsonResponse({ data: { Viewer: { id: 1, name: 'Me' } } }));

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fl_test_tok' },
        body: JSON.stringify({ query: 'query { Viewer { id name } }' })
      });
      expect(CoreHooks.getAuthHeader()).toBe('Bearer fl_test_tok');

      gmStore.del('al_user_id');
      gmStore.del('al_username');
      extractUsersFromRpcResult({ User: { id: 999, name: 'Stranger', avatar: { medium: 'x' } } });
      expect(gmStore.get('al_user_id', null)).toBeNull();
      expect(gmStore.get('al_username', null)).toBeNull();

      extractUsersFromRpcResult({ Viewer: { id: 123, name: 'RealViewer' } });
      expect(gmStore.get('al_user_id', null)).toBe(123);
      expect(gmStore.get('al_username', null)).toBe('RealViewer');
    });

    it('routes main Fast Load logs to [Fast Load] and RPC logs to [Fast Load (RPC)] independently', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      Settings.set('devModeEnabled', true);
      Settings.set('debug', {
        fastLoad: { enabled: true, channels: { general: true, rpc: false } }
      });

      try {
        mockNativeFetch.mockResolvedValueOnce(createJsonResponse({ data: { Media: { id: 777 } } }));
        await window.fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'query { Media(id: 777) { id } }' })
        });
        await flushAsync();

        expect(debugSpy.mock.calls.some((c) => c[0] === '[Fast Load]')).toBe(true);
        expect(debugSpy.mock.calls.some((c) => c[0] === '[Fast Load (RPC)]')).toBe(false);
      } finally {
        debugSpy.mockRestore();
      }
    });
  });
  describe('FastLoad Regression Suite: BUG-46..BUG-50', () => {

  describe('BUG-46: Taxonomy, Viewer, and MediaListCollection Cache Key Isolation', () => {
    it('prevents cross-poisoning between GenreCollection, MediaTagCollection, and combined taxonomy queries', async () => {
      const genresRes = { data: { GenreCollection: ['Action', 'Drama'] } };
      const tagsRes = { data: { MediaTagCollection: [{ id: 1, name: 'Time Travel' }] } };
      const combinedRes = {
        data: { GenreCollection: ['Action'], MediaTagCollection: [{ id: 1, name: 'Time Travel' }] }
      };

      mockNativeFetch
        .mockResolvedValueOnce(createJsonResponse(genresRes))
        .mockResolvedValueOnce(createJsonResponse(tagsRes))
        .mockResolvedValueOnce(createJsonResponse(combinedRes));

      const r1 = await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query { GenreCollection }' })
      });
      await flushAsync();

      const r2 = await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query { MediaTagCollection { id name } }' })
      });
      await flushAsync();

      const r3 = await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query { GenreCollection MediaTagCollection { id name } }' })
      });
      await flushAsync();

      expect(mockNativeFetch).toHaveBeenCalledTimes(3);
      expect(await r1.json()).toEqual(genresRes);
      expect(await r2.json()).toEqual(tagsRes);
      expect(await r3.json()).toEqual(combinedRes);

      expect(rpcKey(['/graphql', 'query { GenreCollection }', {}, {}])).not.toBe(
        rpcKey(['/graphql', 'query { MediaTagCollection { id name } }', {}, {}])
      );
      expect(rpcKey(['/graphql', 'query { MediaTagCollection { id } }', {}, {}])).not.toBe(
        rpcKey(['/graphql', 'query { MediaTagCollection { id name } }', {}, {}])
      );
    });

    it('isolates Viewer queries by normalized selection set and auth identity and ignores comments/operation names', async () => {
      expect(isViewerQuery({ query: 'query ViewerProfile { Media(id: 1) { id } }' })).toBe(false);
      expect(isViewerQuery({ query: 'query { # Viewer\n Media(id: 1) { id } }' })).toBe(false);
      expect(isViewerQuery({ query: 'query { Viewer { id } }' })).toBe(true);
      expect(isTaxonomyQuery({ query: 'query { # GenreCollection\n Media(id: 1) { id } }' })).toBe(false);

      const v1 = { data: { Viewer: { id: 1 } } };
      const v2 = { data: { Viewer: { id: 1, mediaListOptions: { scoreFormat: 'POINT_100' } } } };
      const v3 = { data: { Viewer: { id: 2 } } };

      mockNativeFetch
        .mockResolvedValueOnce(createJsonResponse(v1))
        .mockResolvedValueOnce(createJsonResponse(v2))
        .mockResolvedValueOnce(createJsonResponse(v3));

      const r1 = await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token_A' },
        body: JSON.stringify({ query: 'query { Viewer { id } }' })
      });
      await flushAsync();

      const r2 = await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token_A' },
        body: JSON.stringify({ query: 'query { Viewer { id mediaListOptions { scoreFormat } } }' })
      });
      await flushAsync();

      const r3 = await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token_B' },
        body: JSON.stringify({ query: 'query { Viewer { id } }' })
      });
      await flushAsync();

      expect(mockNativeFetch).toHaveBeenCalledTimes(3);
      expect(await r1.json()).toEqual(v1);
      expect(await r2.json()).toEqual(v2);
      expect(await r3.json()).toEqual(v3);

      expect(
        rpcKey(['/graphql', 'query { Viewer { id } }', {}, { Authorization: 'Bearer tokA' }])
      ).not.toBe(
        rpcKey(['/graphql', 'query { Viewer { id } }', {}, { Authorization: 'Bearer tokB' }])
      );
      expect(
        rpcKey(['/graphql', 'query { Viewer { id } }', {}, { Authorization: 'Bearer tokA' }])
      ).not.toBe(
        rpcKey(['/graphql', 'query { Viewer { id name } }', {}, { Authorization: 'Bearer tokA' }])
      );
    });

    it('restricts MediaListCollection :{} alias writes and rpc:listTpl:v2 to unfiltered un-chunked queries', async () => {
      expect(isUnfilteredMediaListVars({ userId: 1, type: 'ANIME' })).toBe(true);
      expect(isUnfilteredMediaListVars({ userId: 1, type: 'ANIME', chunk: 2, perChunk: 500 })).toBe(false);
      expect(isUnfilteredMediaListVars({ userId: 1, type: 'ANIME', status: 'COMPLETED' })).toBe(false);

      const origWorker = window.Worker;
      class FakeWorker extends EventTarget {
        postMessage(data: any) {
          setTimeout(() => {
            this.dispatchEvent(
              new MessageEvent('message', {
                data: {
                  type: 'RPC',
                  id: data.id,
                  result: {
                    MediaListCollection: {
                      user: { id: 88001, name: 'FilteredUser' },
                      lists: [{ name: 'Completed', isCustomList: false, entries: [] }]
                    }
                  }
                }
              })
            );
          }, 0);
        }
        terminate() {}
      }

      try {
        (window as any).Worker = FakeWorker;
        const unhookFake = hookWorker(() => false);
        try {
          const w = new window.Worker('/app.worker.js');
          const chunkedParams = [
            '/graphql',
            'query($userId:Int,$type:MediaType,$chunk:Int){MediaListCollection(userId:$userId,type:$type,chunk:$chunk){lists{name}}}',
            { userId: 88001, type: 'ANIME', chunk: 2 },
            {}
          ];
          w.postMessage({
            type: 'RPC',
            id: 'filtered-1',
            method: 'fetch',
            params: chunkedParams
          });
          await flushAsync();

          const rpcCache = (window as any).__ALFL_RPC_CACHE__ as Map<string, any>;
          expect(rpcCache.get('rpc:MediaListCollection:ANIME:88001:{}')).toBeUndefined();
          expect(rpcCache.get(rpcKey(chunkedParams))).toBeDefined();
          expect(gmStore.get('ala_mod_fastLoad_rpc:listTpl:v2', null)).toBeNull();
        } finally {
          unhookFake();
        }
      } finally {
        (window as any).Worker = origWorker;
        await _boot('fastLoad');
      }
    });
  });

  describe('BUG-47: Full-Payload GraphQL Error Detection', () => {
    it('never caches HTTP 200 responses with errors following data or malformed JSON', async () => {
      const padding = 'x'.repeat(2500);
      const lateErrorPayload = {
        data: { Media: { id: 42, description: padding } },
        errors: [{ message: 'Partial failure beyond 2KB' }]
      };
      mockNativeFetch
        .mockResolvedValueOnce(createJsonResponse(lateErrorPayload, 200))
        .mockResolvedValueOnce(createJsonResponse({ data: { Media: { id: 42 } } }, 200));

      const body = JSON.stringify({ query: 'query LateErr { Media(id: 42) { id description } }' });
      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      await flushAsync();

      const gqlStore = (window as any).__ALFL_GQL_STORE__ as Map<string, any>;
      expect(gqlStore.size).toBe(0);

      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      expect(mockNativeFetch).toHaveBeenCalledTimes(2);

      mockNativeFetch.mockResolvedValueOnce(
        new Response('<html>not json</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
      );
      await window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query MalformedJson { Media(id: 43) { id } }' })
      });
      await flushAsync();
      expect([...gqlStore.keys()].some((k) => k.includes('MalformedJson'))).toBe(false);
    });
  });

  describe('BUG-48: In-Flight Deduplication Without Duplicate Network Fallback', () => {
    it.each([
      ['HTTP 429', () => createJsonResponse({ errors: [{ message: 'Too Many Requests' }] }, 429, 'Too Many Requests'), 429],
      ['HTTP 500', () => createJsonResponse({ error: 'Server Error' }, 500, 'Internal Server Error'), 500],
      ['HTTP 200 GraphQL errors', () => createJsonResponse({ data: { Media: null }, errors: [{ message: 'Not Found' }] }, 200), 200]
    ])('coalesces concurrent %s responses into a single network fetch without caching', async (_label, makeRes, expectedStatus) => {
      let resolveFetch!: (res: Response) => void;
      mockNativeFetch.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );

      const body = JSON.stringify({ query: `query DedupErr_${expectedStatus} { Media(id: ${expectedStatus}) { id } }` });
      const p1 = window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      const p2 = window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      const p3 = window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      await flushAsync();
      expect(mockNativeFetch).toHaveBeenCalledTimes(1);

      resolveFetch(makeRes());
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.status).toBe(expectedStatus);
      expect(r2.status).toBe(expectedStatus);
      expect(r3.status).toBe(expectedStatus);
      expect(mockNativeFetch).toHaveBeenCalledTimes(1);
      expect(((window as any).__ALFL_GQL_STORE__ as Map<string, any>).size).toBe(0);
    });

    it('does not fire fallback fetch when waiter AbortSignal is aborted before network rejection', async () => {
      let rejectFetch!: (err: Error) => void;
      mockNativeFetch.mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectFetch = reject;
          })
      );

      const ac = new AbortController();
      const body = JSON.stringify({ query: 'query AbortWaiter { Media(id: 909) { id } }' });
      const p1 = window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      const p2 = window.fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ac.signal
      });

      await flushAsync();
      ac.abort();
      await expect(p2).rejects.toThrow();

      rejectFetch(new TypeError('network down'));
      await expect(p1).rejects.toThrow('network down');
      await flushAsync();
      expect(mockNativeFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('BUG-49: Route Timer Cleanup, safeDecodeURIComponent, and rpcInflight Identity', () => {
    it('safely handles malformed percent-encoding in route and pointer prefetch paths', () => {
      history.replaceState({}, '', '/user/%E0%A4%A');
      expect(() => autoPrefetchListsForCurrentRoute(() => false)).not.toThrow();

      const anchor = document.createElement('a');
      anchor.href = `${window.location.origin}/user/%E0%A4%A/animelist`;
      expect(() => prefetchFor(anchor, () => false)).not.toThrow();
    });

    it('cancels pending auto-prefetch timers on navigation to /compare and cleanupRoutes()', async () => {
      vi.useFakeTimers();
      const origWorker = window.Worker;
      const workerConstructs = vi.fn();

      class SpyWorker extends EventTarget {
        constructor() {
          super();
          workerConstructs();
        }
        postMessage() {}
        terminate() {}
      }

      try {
        (window as any).Worker = SpyWorker;
        const unhook = hookWorker(() => false);
        gmStore.set(
          'ala_mod_fastLoad_rpc:listTpl:v2',
          JSON.stringify({
            endpoint: '/graphql',
            query: 'query($userId:Int,$type:MediaType){MediaListCollection(userId:$userId,type:$type){lists{name}}}',
            vars: { type: 'ANIME' },
            headers: {}
          })
        );
        gmStore.set('ala_mod_fastLoad_workerUrl', 'https://anilist.co/app.worker.js');

        history.replaceState({}, '', '/user/TargetSomeone');
        scheduleAutoPrefetch(() => false, 50);
        await vi.advanceTimersByTimeAsync(60);

        // Navigate to /compare before 100-800ms inner timers fire
        history.replaceState({}, '', '/anime/1/compare');
        await vi.advanceTimersByTimeAsync(1000);
        expect(workerConstructs).toHaveBeenCalledTimes(0);

        // Now schedule on normal route, then dispose routes before timers fire
        history.replaceState({}, '', '/user/TargetSomeoneTwo');
        autoPrefetchListsForCurrentRoute(() => false);
        cleanupRoutes();
        await vi.advanceTimersByTimeAsync(1000);
        expect(workerConstructs).toHaveBeenCalledTimes(0);

        unhook();
      } finally {
        (window as any).Worker = origWorker;
        vi.useRealTimers();
        initRoutes();
        await _boot('fastLoad');
      }
    });

    it('preserves newer rpcInflight entries when an older prefetch worker finishes or times out', async () => {
      vi.useFakeTimers();
      const origWorker = window.Worker;
      const workers: any[] = [];

      class ManualWorker extends EventTarget {
        postMessage = vi.fn();
        terminate = vi.fn();
        constructor() {
          super();
          workers.push(this);
        }
      }

      try {
        (window as any).Worker = ManualWorker;
        const unhook = hookWorker(() => false);
        gmStore.set(
          'ala_mod_fastLoad_rpc:listTpl:v2',
          JSON.stringify({
            endpoint: '/graphql',
            query: 'query($userId:Int,$type:MediaType){MediaListCollection(userId:$userId,type:$type){lists{name}}}',
            vars: { type: 'ANIME' },
            headers: {}
          })
        );
        gmStore.set('ala_mod_fastLoad_workerUrl', 'https://anilist.co/app.worker.js');

        prefetchWorkerList('ANIME', 55501, 'OldUser');
        const rpcInflight = (window as any).__ALFL_RPC_INFLIGHT__ as Map<string, any>;
        const key = 'rpc:MediaListCollection:ANIME:55501:{}';
        const firstFlight = rpcInflight.get(key);
        expect(firstFlight).toBeDefined();

        // Simulate cache clear replacing the inflight entry with a newer flight
        const newerFlight = { promise: new Promise(() => {}), resolve: vi.fn(), reject: vi.fn() };
        rpcInflight.set(key, newerFlight);

        // Old worker times out after 30s — must NOT clobber newerFlight
        await vi.advanceTimersByTimeAsync(30_000);
        expect(rpcInflight.get(key)).toBe(newerFlight);
        expect(newerFlight.reject).not.toHaveBeenCalled();

        unhook();
      } finally {
        (window as any).Worker = origWorker;
        vi.useRealTimers();
        await _boot('fastLoad');
      }
    });
  });

  describe('BUG-50: Global Bridge, Monkey-Patch, and CoalescedMutationObserver Cleanup', () => {
    it('clears CoalescedMutationObserver timer on disconnect() so subsequent observe() works', async () => {
      vi.useFakeTimers();
      const origMO = window.MutationObserver;
      const undo = installObserverCoalescing();
      try {
        const cb = vi.fn();
        const obs = new window.MutationObserver(cb);
        obs.observe(document.body, { childList: true, subtree: true });

        const el1 = document.createElement('div');
        document.body.appendChild(el1);
        obs.disconnect();

        // Re-observe immediately before the old batch timer would have fired
        obs.observe(document.body, { childList: true, subtree: true });
        const el2 = document.createElement('div');
        document.body.appendChild(el2);

        await vi.advanceTimersByTimeAsync(150);
        expect(cb).toHaveBeenCalledTimes(1);

        obs.disconnect();
        el1.remove();
        el2.remove();
      } finally {
        undo();
        expect(window.MutationObserver).toBe(origMO);
        vi.useRealTimers();
      }
    });

    it('restores DOM prototypes, styles, globals, fetch, and Worker on cleanup and re-boots cleanly', async () => {
      const origCreate = Document.prototype.createElement;
      const origInsert = Element.prototype.insertAdjacentHTML;
      const origInnerDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');

      const undoLazy = installLazyMedia();
      expect(Document.prototype.createElement).not.toBe(origCreate);
      undoLazy();
      expect(Document.prototype.createElement).toBe(origCreate);
      expect(Element.prototype.insertAdjacentHTML).toBe(origInsert);
      expect(Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')?.set).toBe(origInnerDesc?.set);

      const undoRows = installRowSkipping();
      undoRows();

      const origWorker = window.Worker;
      class TestWorker extends EventTarget {
        postMessage() {}
        terminate() {}
      }

      try {
        (window as any).Worker = TestWorker;
        await _boot('fastLoad');

        // Full module disposal & re-boot lifecycle
        const hookedFetch = window.fetch;
        const hookedWorkerCtor = window.Worker;
        const hookedPost = window.Worker.prototype.postMessage;
        expect(hookedWorkerCtor).not.toBe(TestWorker);

        disposeFeature('fastLoad');

        expect((window as any).__ALA_FAST_LOAD__).toBeUndefined();
        expect((window as any).__ALFL_STATS__).toBeUndefined();
        expect((window as any).__ALFL_CLEAR__).toBeUndefined();
        expect((window as any).__ALFL_GQL_STORE__).toBeUndefined();
        expect((window as any).__ALFL_RPC_CACHE__).toBeUndefined();
        expect((window as any).__ALFL_RPC_INFLIGHT__).toBeUndefined();
        expect((window as any).__ALFL_USER_MAP__).toBeUndefined();
        expect((window as any).__ALFL_ID_MAP__).toBeUndefined();
        expect(CoreHooks.getCacheBridge()).toBeNull();
        expect(window.fetch).not.toBe(hookedFetch);
        expect(window.Worker).toBe(TestWorker);
        expect(window.Worker.prototype.postMessage).not.toBe(hookedPost);
      } finally {
        (window as any).Worker = origWorker;
        window.fetch = ((...args: any[]) => mockNativeFetch(...args)) as any;
        await _boot('fastLoad');
      }
      expect((window as any).__ALA_FAST_LOAD__).toBe('0.4.3');
      expect((window as any).__ALFL_STATS__).toBeDefined();
      expect(CoreHooks.getCacheBridge()).not.toBeNull();
    });

    it('IMP-04: cancels tracked persistRoutes debounce, auto-prefetch timeouts, and pointer dwell timeout on module disposal', async () => {
      vi.useFakeTimers();
      const origWorker = window.Worker;
      const workerConstructs = vi.fn();

      class SpyWorker extends EventTarget {
        constructor() {
          super();
          workerConstructs();
        }
        postMessage() {}
        terminate() {}
      }

      try {
        (window as any).Worker = SpyWorker;
        await _boot('fastLoad');
        gmStore.set(
          'ala_mod_fastLoad_rpc:listTpl:v2',
          JSON.stringify({
            endpoint: '/graphql',
            query: 'query($userId:Int,$type:MediaType){MediaListCollection(userId:$userId,type:$type){lists{name}}}',
            vars: { type: 'ANIME' },
            headers: {}
          })
        );
        gmStore.set('ala_mod_fastLoad_workerUrl', 'https://anilist.co/app.worker.js');

        // 1. Trigger persistRoutes via route learning, then dispose before 1000ms debounce fires
        gmStore.del('ala_mod_fastLoad_routes:v4');
        history.replaceState({}, '', '/anime/424242');
        mockNativeFetch.mockResolvedValueOnce(
          createJsonResponse({ data: { Media: { id: 424242 } } })
        );
        await window.fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'query ($id: Int) { Media(id: $id) { id } }',
            variables: { id: 424242 }
          })
        });
        await vi.advanceTimersByTimeAsync(10);

        // 2. Schedule auto-prefetch and pointer dwell timers, then dispose module before they fire
        history.replaceState({}, '', '/user/TargetBeforeDispose');
        scheduleAutoPrefetch(() => false, 300);

        const link = document.createElement('a');
        link.href = `${window.location.origin}/anime/424242`;
        document.body.appendChild(link);
        link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));

        disposeFeature('fastLoad');
        await vi.advanceTimersByTimeAsync(2000);

        expect(gmStore.get('ala_mod_fastLoad_routes:v4', null)).toBeNull();
        expect(workerConstructs).toHaveBeenCalledTimes(0);
        link.remove();
      } finally {
        (window as any).Worker = origWorker;
        window.fetch = ((...args: any[]) => mockNativeFetch(...args)) as any;
        vi.useRealTimers();
        await _boot('fastLoad');
      }
    });

    it('IMP-16: captures markFetchOwner(true) lease and releases only its own lease on yield and disposal', async () => {
      const gqlEvents: any[] = [];
      const unsubGql = CoreHooks.onGqlFetch((ev) => gqlEvents.push(ev));
      const externalLease = CoreHooks.markFetchOwner(true);

      try {
        await _boot('fastLoad');

        // Yielding to standalone should release fastLoad's lease without clearing externalLease
        (window as any).__ANILIST_FAST_LOAD__ = { active: true };
        mockNativeFetch.mockResolvedValueOnce(createJsonResponse({ data: { Media: { id: 9001 } } }));
        await window.fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'query { Media(id: 9001) { id } }' })
        });
        // Because externalLease is still held, fallback fetch must NOT have installed yet
        expect(gqlEvents).toHaveLength(0);

        delete (window as any).__ANILIST_FAST_LOAD__;
        disposeFeature('fastLoad');

        // Releasing externalLease now leaves 0 owners, so fallback fetch installs for gql subscribers
        externalLease();
        mockNativeFetch.mockResolvedValueOnce(createJsonResponse({ data: { Media: { id: 9002 } } }));
        await window.fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'query { Media(id: 9002) { id } }' })
        });
        expect(gqlEvents.some((e) => e.phase === 'request')).toBe(true);
      } finally {
        delete (window as any).__ANILIST_FAST_LOAD__;
        externalLease();
        unsubGql();
        window.fetch = ((...args: any[]) => mockNativeFetch(...args)) as any;
        await _boot('fastLoad');
      }
    });
  });

  describe('Cycle 2: BUG-22..BUG-26', () => {
    it('BUG-22: forwards wrappedPost cache hit and in-flight prefetch RPCs to origPost when fastLoad disposes or yields', async () => {
      vi.useFakeTimers();
      const origWorker = window.Worker;
      const origPostCalls: any[] = [];

      class FallbackWorker extends EventTarget {
        postMessage(data: any) {
          origPostCalls.push(data);
          setTimeout(() => {
            this.dispatchEvent(
              new MessageEvent('message', {
                data: { type: 'RPC', id: data.id, result: { MediaListCollection: { lists: [{ name: 'RealWorker' }] } } }
              })
            );
          }, 0);
        }
        terminate() {}
      }

      try {
        (window as any).Worker = FallbackWorker;

        // 1. Cache hit setTimeout(..., 0) falls back to origPost if unhooked before tick 0
        let unhook = hookWorker(() => false);
        const w1 = new window.Worker('/app.worker.js');
        const rpcCache = (window as any).__ALFL_RPC_CACHE__ as Map<string, any>;
        rpcCache.set('rpc:MediaListCollection:ANIME:55511:{}', {
          time: Date.now(),
          msg: { type: 'RPC', id: 'cached', result: { MediaListCollection: { lists: [{ name: 'Cached' }] } } }
        });

        const w1Msgs: any[] = [];
        w1.addEventListener('message', (ev: MessageEvent) => w1Msgs.push(ev.data));
        w1.postMessage({
          type: 'RPC',
          id: 'hit-disposed',
          method: 'fetch',
          params: [
            '/graphql',
            'query($userId:Int,$type:MediaType){MediaListCollection(userId:$userId,type:$type){lists{name}}}',
            { userId: 55511, type: 'ANIME' },
            {}
          ]
        });

        // Dispose fastLoad worker hook before tick 0 fires
        unhook();
        await vi.advanceTimersByTimeAsync(10);
        expect(origPostCalls.some((c) => c.id === 'hit-disposed')).toBe(true);
        expect(w1Msgs.some((m) => m.id === 'hit-disposed' && m.result?.MediaListCollection?.lists?.[0]?.name === 'RealWorker')).toBe(true);

        // 2. In-flight prefetch rejects when yielded/disposed -> must forward to origPost unconditionally
        let yieldedFlag = false;
        unhook = hookWorker(() => yieldedFlag);
        const w2 = new window.Worker('/app.worker.js');
        const rpcInflight = (window as any).__ALFL_RPC_INFLIGHT__ as Map<string, any>;
        let rejectFlight!: (err: Error) => void;
        const flightPromise = new Promise((_res, rej) => {
          rejectFlight = rej;
        });
        flightPromise.catch(() => {});
        rpcInflight.set('rpc:MediaListCollection:ANIME:55512:{}', {
          promise: flightPromise,
          resolve: () => {},
          reject: rejectFlight
        });

        const w2Msgs: any[] = [];
        w2.addEventListener('message', (ev: MessageEvent) => w2Msgs.push(ev.data));
        w2.postMessage({
          type: 'RPC',
          id: 'inflight-yielded',
          method: 'fetch',
          params: [
            '/graphql',
            'query($userId:Int,$type:MediaType){MediaListCollection(userId:$userId,type:$type){lists{name}}}',
            { userId: 55512, type: 'ANIME' },
            {}
          ]
        });

        yieldedFlag = true;
        rejectFlight(new Error('stale'));
        await vi.advanceTimersByTimeAsync(10);
        expect(origPostCalls.some((c) => c.id === 'inflight-yielded')).toBe(true);
        expect(w2Msgs.some((m) => m.id === 'inflight-yielded' && m.result?.MediaListCollection?.lists?.[0]?.name === 'RealWorker')).toBe(true);
        unhook();

        // 3. In-flight prefetch resolves, then fastLoad disposes before inner setTimeout(..., 0) fires
        unhook = hookWorker(() => false);
        const w3 = new window.Worker('/app.worker.js');
        let resolveFlight!: (val: any) => void;
        const flightPromise3 = new Promise((res) => {
          resolveFlight = res;
        });
        rpcInflight.set('rpc:MediaListCollection:ANIME:55513:{}', {
          promise: flightPromise3,
          resolve: resolveFlight,
          reject: () => {}
        });

        const w3Msgs: any[] = [];
        w3.addEventListener('message', (ev: MessageEvent) => w3Msgs.push(ev.data));
        w3.postMessage({
          type: 'RPC',
          id: 'inflight-resolved-then-disposed',
          method: 'fetch',
          params: [
            '/graphql',
            'query($userId:Int,$type:MediaType){MediaListCollection(userId:$userId,type:$type){lists{name}}}',
            { userId: 55513, type: 'ANIME' },
            {}
          ]
        });

        resolveFlight({ type: 'RPC', id: 'pf', result: { MediaListCollection: { lists: [{ name: 'Prefetched' }] } } });
        // Flush microtask so .then schedules inner setTimeout(..., 0), then dispose before tick 0
        await Promise.resolve();
        await Promise.resolve();
        unhook();
        await vi.advanceTimersByTimeAsync(10);
        expect(origPostCalls.some((c) => c.id === 'inflight-resolved-then-disposed')).toBe(true);
        expect(w3Msgs.some((m) => m.id === 'inflight-resolved-then-disposed' && m.result?.MediaListCollection?.lists?.[0]?.name === 'RealWorker')).toBe(true);
      } finally {
        (window as any).Worker = origWorker;
        vi.useRealTimers();
        await _boot('fastLoad');
      }
    });

    it('BUG-23: terminates prefetch worker and 30s timer on cleanup, guards error wipe, and clears/caps cooldown maps', async () => {
      vi.useFakeTimers();
      const origWorker = window.Worker;
      const spawned: Array<{ postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; dispatchEvent: (e: Event) => boolean }> = [];

      class TrackedWorker extends EventTarget {
        postMessage = vi.fn();
        terminate = vi.fn();
        constructor() {
          super();
          spawned.push(this);
        }
      }

      try {
        (window as any).Worker = TrackedWorker;
        let yieldedFlag = false;
        let unhook = hookWorker(() => yieldedFlag);
        gmStore.set(
          'ala_mod_fastLoad_rpc:listTpl:v2',
          JSON.stringify({
            endpoint: '/graphql',
            query: 'query($userId:Int,$type:MediaType){MediaListCollection(userId:$userId,type:$type){lists{name}}}',
            vars: { type: 'ANIME' },
            headers: {}
          })
        );
        gmStore.set('ala_mod_fastLoad_workerUrl', 'https://anilist.co/app.worker.js');

        prefetchWorkerList('ANIME', 61001, 'UserOne');
        expect(spawned).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);

        // Cleanup must terminate active worker and clear the 30s timer
        unhook();
        expect(spawned[0].terminate).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);

        // Late 'error' after cleanup must NOT delete workerUrl from storage
        spawned[0].dispatchEvent(new Event('error'));
        expect(gmStore.get('ala_mod_fastLoad_workerUrl', null)).toBe('https://anilist.co/app.worker.js');

        // Re-hook and test 'error' guard when epoch bumps or yielded becomes true
        unhook = hookWorker(() => yieldedFlag);
        prefetchWorkerList('ANIME', 61002, 'UserTwo');
        expect(spawned).toHaveLength(2);
        yieldedFlag = true;
        spawned[1].dispatchEvent(new Event('error'));
        expect(gmStore.get('ala_mod_fastLoad_workerUrl', null)).toBe('https://anilist.co/app.worker.js');
        expect(flWorkerUrl === null).toBe(false);
        yieldedFlag = false;
        unhook();

        // clearGlobalCache() clears prefetchedWorkerKeys and routes prefetched cooldown
        unhook = hookWorker(() => false);
        prefetchWorkerList('ANIME', 61003, 'UserThree');
        expect(spawned).toHaveLength(3);
        // Within 60s without clear, second call is skipped
        prefetchWorkerList('ANIME', 61003, 'UserThree');
        expect(spawned).toHaveLength(3);
        // After clearGlobalCache(), cooldown is cleared so re-prefetch runs immediately
        (window as any).__ALFL_CLEAR__();
        prefetchWorkerList('ANIME', 61003, 'UserThree');
        expect(spawned).toHaveLength(4);

        // Cap prefetchedWorkerKeys when >200 distinct keys are prefetched
        for (let i = 0; i < 210; i++) {
          prefetchWorkerList('ANIME', 70000 + i);
        }
        expect(spawned.length).toBe(4 + 210);
        unhook();

        // clearGlobalCache() also clears routes.ts's prefetched cooldown map
        initRoutes();
        history.replaceState({}, '', '/anime/1');
        learned.set('anime/', {
          route: { shape: 'anime/', id: 1, static: false },
          reqs: [{ url: 'https://graphql.anilist.co', body: JSON.stringify({ query: 'query($id:Int){Media(id:$id){id}}', variables: { id: 1 } }), headers: {} }],
          t: Date.now()
        });
        mockNativeFetch.mockResolvedValue(createJsonResponse({ data: { Media: { id: 99 } } }));
        const link = document.createElement('a');
        link.href = `${window.location.origin}/anime/99`;
        const flStats = (window as any).__ALFL_STATS__;
        const beforePrefetched = flStats.prefetched;
        prefetchFor(link, () => false);
        expect(flStats.prefetched).toBe(beforePrefetched + 1);
        prefetchFor(link, () => false);
        expect(flStats.prefetched).toBe(beforePrefetched + 1);
        (window as any).__ALFL_CLEAR__();
        prefetchFor(link, () => false);
        expect(flStats.prefetched).toBe(beforePrefetched + 2);
      } finally {
        (window as any).Worker = origWorker;
        vi.useRealTimers();
        await _boot('fastLoad');
      }
    });

    it('BUG-24: installLazyMedia avoids double-wrapping doc.createElement and restores prototype inheritance cleanly', () => {
      const origProtoCreate = Document.prototype.createElement;
      expect(Object.prototype.hasOwnProperty.call(document, 'createElement')).toBe(false);

      const createSpy = vi.fn(origProtoCreate);
      Document.prototype.createElement = createSpy as any;

      try {
        const undo = installLazyMedia();
        expect(Document.prototype.createElement).not.toBe(createSpy);
        // document must NOT get its own shadowed wrapper when inheriting from already-patched Document.prototype
        expect(Object.prototype.hasOwnProperty.call(document, 'createElement')).toBe(false);

        const img = document.createElement('img') as HTMLImageElement;
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(img.loading).toBe('lazy');
        expect(img.decoding).toBe('async');

        undo();
        expect(Document.prototype.createElement).toBe(createSpy);
        expect(Object.prototype.hasOwnProperty.call(document, 'createElement')).toBe(false);

        const postImg = document.createElement('img') as HTMLImageElement;
        expect(postImg.loading).not.toBe('lazy');
        expect(postImg.decoding).not.toBe('async');
      } finally {
        Document.prototype.createElement = origProtoCreate;
      }
    });

    it('BUG-25: isolates inline literal MediaListCollection queries, conflicts, and multi-root queries from canonical :{} keys', () => {
      // 1. Inline literal args for another user without variables
      const inlineOther = {
        query: 'query { MediaListCollection(userName: "OtherUser", type: MANGA) { lists { name } } }',
        variables: {}
      };
      expect(isUnfilteredMediaListQuery(inlineOther)).toBe(true);
      expect(makeKey({ url: '/graphql', headers: new Headers() }, inlineOther)).toBe(
        'gql:MediaListCollection:MANGA:otheruser:{}'
      );
      expect(rpcKey(['/graphql', inlineOther.query, inlineOther.variables, {}])).toBe(
        'rpc:MediaListCollection:MANGA:otheruser:{}'
      );

      // 2. Conflicting inline literal vs variables must NOT emit canonical :{}
      const conflicting = {
        query: 'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: 999, type: ANIME) { lists { name } } }',
        variables: { userId: 123, type: 'MANGA' }
      };
      expect(isUnfilteredMediaListQuery(conflicting)).toBe(false);
      const conflictGqlKey = makeKey({ url: '/graphql', headers: new Headers() }, conflicting);
      const conflictRpcKey = rpcKey(['/graphql', conflicting.query, conflicting.variables, {}]);
      expect(conflictGqlKey.endsWith(':{}')).toBe(false);
      expect(conflictRpcKey.endsWith(':{}')).toBe(false);

      // 3. Unrecognized inline argument (status: COMPLETED) must NOT emit canonical :{}
      const inlineFiltered = {
        query: 'query { MediaListCollection(userId: 123, type: ANIME, status: COMPLETED) { lists { name } } }',
        variables: {}
      };
      expect(isUnfilteredMediaListQuery(inlineFiltered)).toBe(false);
      expect(makeKey({ url: '/graphql', headers: new Headers() }, inlineFiltered).endsWith(':{}')).toBe(false);
      expect(rpcKey(['/graphql', inlineFiltered.query, {}, {}]).endsWith(':{}')).toBe(false);

      // 4. Multi-root query (fields.size > 1) must NOT emit canonical :{}
      const multiRoot = {
        query: 'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { lists { name } } Viewer { id } }',
        variables: { userId: 123, type: 'ANIME' }
      };
      expect(isUnfilteredMediaListQuery(multiRoot)).toBe(false);
      expect(makeKey({ url: '/graphql', headers: new Headers() }, multiRoot).endsWith(':{}')).toBe(false);
      expect(rpcKey(['/graphql', multiRoot.query, multiRoot.variables, {}]).endsWith(':{}')).toBe(false);
    });

    it('BUG-26: clears RAM caches, userMap, idToUserMap, learned, and auth/pause state on disposeFeature("fastLoad") while preserving coreStorage', async () => {
      try {
        await _boot('fastLoad');
        gmStore.set('ala_mod_fastLoad_workerUrl', 'https://anilist.co/app.worker.js');

        // Populate gqlStore via fetch
        mockNativeFetch.mockResolvedValueOnce(createJsonResponse({ data: { Media: { id: 12345 } } }));
        await window.fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'query { Media(id: 12345) { id } }' })
        });
        await flushAsync();
        expect(flStore.size).toBeGreaterThan(0);

        // Populate rpcCache, userMap, idToUserMap, learned, pausedUntil
        flRpcCache.set('rpc:test', { time: Date.now(), msg: { ok: true } });
        extractUsersFromRpcResult({ User: { id: 4242, name: 'DisposedUser', avatar: { medium: 'x' } } });
        learned.set('anime/', { route: { shape: 'anime/', id: 1 }, reqs: [], t: Date.now() });
        setPausedUntil(Date.now() + 60_000);

        expect(flUserMap.get('disposeduser')).toBe(4242);
        expect(flIdToUserMap.get(4242)).toBe('disposeduser');
        expect(learned.size).toBeGreaterThan(0);

        disposeFeature('fastLoad');

        expect(flStore.size).toBe(0);
        expect(flRpcCache.size).toBe(0);
        expect(flUserMap.size).toBe(0);
        expect(flIdToUserMap.size).toBe(0);
        expect(learned.size).toBe(0);
        expect(flPausedUntil).toBe(0);
        expect(flFreshFloor).toBe(0);
        expect(flLastAuth).toBe('');
        // Persistent coreStorage keys remain intact
        expect(gmStore.get('ala_mod_fastLoad_workerUrl', null)).toBe('https://anilist.co/app.worker.js');
      } finally {
        window.fetch = ((...args: any[]) => mockNativeFetch(...args)) as any;
        await _boot('fastLoad');
      }
    });

    it('IMP-10: populates GqlFetchEvent.errors on HTTP 200 GraphQL error payloads in trackedNativeFetch and worker onIn', async () => {
      const gqlEvents: any[] = [];
      const unsub = CoreHooks.onGqlFetch((ev) => gqlEvents.push(ev));
      const origWorker = window.Worker;

      class MockWorker extends EventTarget {
        postMessage(_data: any) {}
        terminate() {}
      }

      try {
        mockNativeFetch
          .mockResolvedValueOnce(
            createJsonResponse({
              data: { DeleteMediaListEntry: null },
              errors: [{ message: 'Denied by server', status: 403 }]
            })
          )
          .mockResolvedValueOnce(
            createJsonResponse({
              data: { DeleteMediaListEntry: { deleted: true } }
            })
          );

        await window.fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'mutation DeleteEntry($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }',
            variables: { id: 10 },
            operationName: 'DeleteEntry'
          })
        });
        await window.fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'mutation DeleteEntry($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }',
            variables: { id: 11 },
            operationName: 'DeleteEntry'
          })
        });
        await flushAsync();

        const fetchResponses = gqlEvents.filter((e) => e.phase === 'response');
        expect(fetchResponses).toHaveLength(2);
        expect(fetchResponses[0]).toMatchObject({
          ok: true,
          status: 200,
          data: { DeleteMediaListEntry: null },
          errors: [{ message: 'Denied by server', status: 403 }]
        });
        expect(fetchResponses[1].errors).toBeUndefined();

        gqlEvents.length = 0;
        (window as any).Worker = MockWorker;
        const unhook = hookWorker(() => false);
        try {
          const w = new window.Worker('/app.worker.js');
          const mutationQuery = 'mutation SaveEntry($mediaId: Int) { SaveMediaListEntry(mediaId: $mediaId) { id } }';

          w.postMessage({ type: 'RPC', id: 'm1', method: 'fetch', params: ['/graphql', mutationQuery, { mediaId: 1 }, {}] });
          w.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'RPC',
                id: 'm1',
                result: { data: { SaveMediaListEntry: null }, errors: [{ message: 'Worker validation failed' }] }
              }
            })
          );

          w.postMessage({ type: 'RPC', id: 'm2', method: 'fetch', params: ['/graphql', mutationQuery, { mediaId: 2 }, {}] });
          w.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'RPC',
                id: 'm2',
                error: 'Worker transport error'
              }
            })
          );

          w.postMessage({ type: 'RPC', id: 'm3', method: 'fetch', params: ['/graphql', mutationQuery, { mediaId: 3 }, {}] });
          w.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'RPC',
                id: 'm3',
                result: { data: { SaveMediaListEntry: { id: 3 } } }
              }
            })
          );

          const workerResponses = gqlEvents.filter((e) => e.phase === 'response');
          expect(workerResponses).toHaveLength(3);
          expect(workerResponses[0]).toMatchObject({
            ok: true,
            status: 200,
            data: { SaveMediaListEntry: null },
            errors: [{ message: 'Worker validation failed' }]
          });
          expect(workerResponses[1]).toMatchObject({
            ok: false,
            status: 500,
            errors: [{ message: 'Worker transport error' }]
          });
          expect(workerResponses[2]).toMatchObject({
            ok: true,
            status: 200,
            data: { SaveMediaListEntry: { id: 3 } }
          });
          expect(workerResponses[2].errors).toBeUndefined();
        } finally {
          unhook();
        }
      } finally {
        unsub();
        (window as any).Worker = origWorker;
        await _boot('fastLoad');
      }
    });

    it('IMP-15: generates symmetric gql:/rpc: cache keys via buildQueryCacheKey and routes RPC blockers through shared isRpcBlocked', async () => {
      const stripPrefix = (k: string) => k.replace(/^(?:gql|rpc):/, '');

      // 1. Canonical MediaListCollection with viewer fallback (getViewerFromWindow().id || 'me')
      const origNuxt = (window as any).__NUXT__;
      try {
        (window as any).__NUXT__ = { state: { auth: { user: { id: 55123, name: 'ViewerSelf' } } } };
        const viewerMlc = {
          query: 'query ($type: MediaType) { MediaListCollection(type: $type) { lists { name } } }',
          variables: { type: 'ANIME' }
        };
        const gqlViewerKey = makeKey({ url: 'https://graphql.anilist.co', headers: new Headers() }, viewerMlc);
        const rpcViewerKey = rpcKey(['https://graphql.anilist.co', viewerMlc.query, viewerMlc.variables, {}]);
        expect(gqlViewerKey).toBe('gql:MediaListCollection:ANIME:55123:{}');
        expect(rpcViewerKey).toBe('rpc:MediaListCollection:ANIME:55123:{}');
        expect(buildQueryCacheKey('gql', 'https://graphql.anilist.co', viewerMlc.query, viewerMlc.variables)).toBe(gqlViewerKey);

        delete (window as any).__NUXT__;
        const anonGqlKey = makeKey({ url: '/graphql', headers: new Headers() }, viewerMlc);
        const anonRpcKey = rpcKey(['/graphql', viewerMlc.query, viewerMlc.variables, {}]);
        expect(anonGqlKey).toBe('gql:MediaListCollection:ANIME:me:{}');
        expect(anonRpcKey).toBe('rpc:MediaListCollection:ANIME:me:{}');
      } finally {
        if (origNuxt === undefined) delete (window as any).__NUXT__;
        else (window as any).__NUXT__ = origNuxt;
      }

      // 2. Non-canonical MediaListCollection (multi-root / conflicting args / filtered) keeps symmetric non-:{} suffix
      const nonCanonicalCases = [
        {
          query: 'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { lists { name } } Viewer { id } }',
          variables: { userId: 777, type: 'MANGA' }
        },
        {
          query: 'query { MediaListCollection(userId: 777, type: ANIME, status: CURRENT) { lists { name } } }',
          variables: {}
        },
        {
          query: 'query ($userId: Int) { MediaListCollection(userId: 999, type: ANIME) { lists { name } } }',
          variables: { userId: 777 }
        }
      ];
      for (const tc of nonCanonicalCases) {
        const g = makeKey({ url: '/graphql', headers: new Headers() }, tc);
        const r = rpcKey(['/graphql', tc.query, tc.variables, {}]);
        expect(g.startsWith('gql:MediaListCollection:')).toBe(true);
        expect(r.startsWith('rpc:MediaListCollection:')).toBe(true);
        expect(g.endsWith(':{}')).toBe(false);
        expect(stripPrefix(g)).toBe(stripPrefix(r));
      }

      // 3. Taxonomy, Viewer, and Generic queries match across makeKey and rpcKey
      const taxQuery = 'query { GenreCollection MediaTagCollection { id name } }';
      const gqlTax = makeKey({ url: '/graphql', headers: new Headers() }, { query: taxQuery, variables: {} });
      const rpcTax = rpcKey(['/graphql', taxQuery, {}, {}]);
      expect(gqlTax.startsWith('gql:Taxonomy:both:')).toBe(true);
      expect(rpcTax.startsWith('rpc:Taxonomy:both:')).toBe(true);
      expect(stripPrefix(gqlTax)).toBe(stripPrefix(rpcTax));

      const viewerQuery = 'query { Viewer { id name } }';
      const gqlViewer = makeKey(
        { url: '/graphql', headers: new Headers({ Authorization: 'Bearer abc123' }) },
        { query: viewerQuery, variables: {} }
      );
      const rpcViewer = rpcKey(['/graphql', viewerQuery, {}, { authorization: 'Bearer abc123' }]);
      expect(gqlViewer.startsWith('gql:Viewer:')).toBe(true);
      expect(rpcViewer.startsWith('rpc:Viewer:')).toBe(true);
      expect(stripPrefix(gqlViewer)).toBe(stripPrefix(rpcViewer));

      const genericQuery = 'query ($id: Int) { Media(id: $id) { id title { romaji } } }';
      const gqlGeneric = makeKey(
        { url: 'https://graphql.anilist.co', headers: new Headers({ authorization: 'Bearer xyz' }) },
        { query: genericQuery, variables: { id: 42 } }
      );
      const rpcGeneric = rpcKey([
        'https://graphql.anilist.co',
        genericQuery,
        { id: 42 },
        { Authorization: 'Bearer xyz' }
      ]);
      expect(gqlGeneric).toBe(rpcGeneric);

      // 4. Shared isRpcBlocked handles CoreHooks blockers, __ALFL_RPC_BLOCK__, and isolates errors
      const pageWin = window as any;
      const unregHookBlocker = CoreHooks.blockRpc((q, v) => q.includes('BlockedOp') && v?.page === 3);
      try {
        expect(isRpcBlocked('query   BlockedOp { Page { id } }', { page: 3 })).toBe(true);
        expect(isRpcBlocked('query   BlockedOp { Page { id } }', { page: 1 })).toBe(false);

        pageWin.__ALFL_RPC_BLOCK__ = (_q: string, v: any) => v?.id === 909 && Number(v?.page) > 1;
        expect(isRpcBlocked('query Any { Page { id } }', { id: 909, page: 2 })).toBe(true);
        expect(isRpcBlocked('query Any { Page { id } }', { id: 909, page: 1 })).toBe(false);

        pageWin.__ALFL_RPC_BLOCK__ = () => {
          throw new Error('blocker boom');
        };
        expect(isRpcBlocked('query Safe { Page { id } }', { id: 1 })).toBe(false);
      } finally {
        unregHookBlocker();
        delete pageWin.__ALFL_RPC_BLOCK__;
      }

      // Verify Worker postMessage also honors CoreHooks blocker via shared isRpcBlocked
      const origWorker = window.Worker;
      const posted: any[] = [];
      class MockBlockWorker extends EventTarget {
        postMessage(data: any) {
          posted.push(data);
        }
        terminate() {}
      }
      const unregWorkerBlocker = CoreHooks.blockRpc((_q, v) => v?.id === 808 && Number(v?.page) > 1);
      (window as any).Worker = MockBlockWorker;
      const unhook = hookWorker(() => false);
      try {
        const w = new window.Worker('/app.worker.js');
        const replies: any[] = [];
        w.addEventListener('message', (ev: any) => replies.push(ev.data));
        w.postMessage({
          type: 'RPC',
          id: 'blk-1',
          method: 'fetch',
          params: ['/graphql', 'query($id:Int,$page:Int){Page(page:$page){mediaList(userId:$id){id}}}', { id: 808, page: 2 }, {}]
        });
        await flushAsync();
        expect(posted).toHaveLength(0);
        expect(replies).toHaveLength(1);
        expect(replies[0].result.data.Page.mediaList).toEqual([]);
      } finally {
        unhook();
        unregWorkerBlocker();
        (window as any).Worker = origWorker;
        await _boot('fastLoad');
      }
    });
  });
});
});
