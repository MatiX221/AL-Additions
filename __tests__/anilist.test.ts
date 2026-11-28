import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadFreshAniList() {
  vi.resetModules();
  const limiterMod = await import('../src/utils/limiter');
  vi.spyOn(limiterMod.RateLimiter.prototype, 'acquire').mockResolvedValue(undefined);
  const [bus, helpers, anilist] = await Promise.all([
    import('../src/core/bus'),
    import('../src/utils/helpers'),
    import('../src/api/anilist')
  ]);
  return { bus, helpers, anilist };
}

function jsonRes(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function encodeGqlSnap(payload: any) {
  return {
    time: Date.now(),
    snap: { buf: new TextEncoder().encode(JSON.stringify(payload)).buffer }
  };
}

function makeMlcPayload(userId: number, userName: string, mediaId: number, extra?: Record<string, any>) {
  return {
    user: { id: userId, name: userName },
    lists: [
      {
        name: 'Completed',
        isCustomList: false,
        status: 'COMPLETED',
        entries: [
          {
            id: mediaId * 10,
            mediaId,
            status: 'COMPLETED',
            score: 9,
            progress: 12,
            media: { id: mediaId, idMal: null, title: { userPreferred: `Media ${mediaId}` } }
          }
        ]
      }
    ],
    ...extra
  };
}

const origWindowFetch = window.fetch;

afterEach(() => {
  window.fetch = origWindowFetch;
  const win = window as any;
  delete win.__NUXT__;
  delete win.__ALFL_USER_MAP__;
  delete win.__ALFL_ID_MAP__;
  delete win.__ALFL_GQL_STORE__;
  delete win.__ALFL_RPC_CACHE__;
  delete win.__ALFL_RPC_INFLIGHT__;
  delete win.__ALFL_CLEAR__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AniList API — B1-10: Session clearing, viewerEpoch, syncFromPage & forceFresh', () => {
  it('clears entityCache and inflightExact on account switch and clearViewer(), returning new user via viewer()', async () => {
    const { helpers, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'Alice' } } } };
    fetchMock.mockResolvedValueOnce(
      jsonRes({ data: { Viewer: { id: 100, name: 'Alice', mediaListOptions: { scoreFormat: 'POINT_10' } } } })
    );

    const vA = await anilist.AniList.viewer();
    expect(vA).toEqual({ id: 100, name: 'Alice', scoreFormat: 'POINT_10' });
    expect(helpers.store.get('al_user_id', 0)).toBe(100);

    let resolveInflight!: (res: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveInflight = resolve;
        })
    );
    const pendingUserAQuery = anilist.AniList.query('query { Page { media { id } } }', {});

    (window as any).__NUXT__ = { state: { auth: { user: { id: 200, name: 'Bob' } } } };
    fetchMock.mockResolvedValueOnce(
      jsonRes({ data: { Viewer: { id: 200, name: 'Bob', mediaListOptions: { scoreFormat: 'POINT_100' } } } })
    );

    const vB = await anilist.AniList.viewer();
    expect(vB).toEqual({ id: 200, name: 'Bob', scoreFormat: 'POINT_100' });
    expect(helpers.store.get('al_user_id', 0)).toBe(200);
    expect(helpers.store.get('al_username', '')).toBe('Bob');
    expect(helpers.store.get('al_score_format', '')).toBe('POINT_100');

    fetchMock.mockResolvedValueOnce(jsonRes({ data: { Page: { media: [{ id: 999 }] } } }));
    const postSwitchPage = await anilist.AniList.query('query { Page { media { id } } }', {});
    expect(postSwitchPage).toEqual({ Page: { media: [{ id: 999 }] } });

    resolveInflight(jsonRes({ data: { Page: { media: [{ id: 111 }] } } }));
    await pendingUserAQuery;
  });

  it('forwards forceFresh from viewer(true) to bypass both store and entityCache', async () => {
    const { helpers, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'Alice' } } } };
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({ data: { Viewer: { id: 100, name: 'Alice', mediaListOptions: { scoreFormat: 'POINT_10' } } } })
      )
      .mockResolvedValueOnce(
        jsonRes({ data: { Viewer: { id: 100, name: 'Alice', mediaListOptions: { scoreFormat: 'POINT_5' } } } })
      );

    const first = await anilist.AniList.viewer();
    expect(first?.scoreFormat).toBe('POINT_10');

    const cached = await anilist.AniList.viewer(false);
    expect(cached?.scoreFormat).toBe('POINT_10');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const fresh = await anilist.AniList.viewer(true);
    expect(fresh?.scoreFormat).toBe('POINT_5');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].cache).toBe('no-store');
    expect(helpers.store.get('al_score_format', '')).toBe('POINT_5');
  });

  it('prevents stale viewer() response from writing User A back to store after concurrent clearViewer() or logout', async () => {
    const { helpers, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'Alice' } } } };

    let resolveViewer!: (res: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveViewer = resolve;
        })
    );

    const viewerPromise = anilist.AniList.viewer();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    anilist.AniList.clearViewer();

    resolveViewer(
      jsonRes({ data: { Viewer: { id: 100, name: 'Alice', mediaListOptions: { scoreFormat: 'POINT_10' } } } })
    );
    const res = await viewerPromise;

    expect(res).toBeNull();
    expect(helpers.store.get('al_user_id', null)).toBeNull();
    expect(helpers.store.get('al_username', null)).toBeNull();
    expect(helpers.store.get('al_score_format', null)).toBeNull();

    delete (window as any).__NUXT__;
    document.body.innerHTML = '<nav><a href="/user/Alice">Alice</a></nav>';
    let resolveViewer2!: (res: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveViewer2 = resolve;
        })
    );

    const viewerPromise2 = anilist.AniList.viewer();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    document.body.innerHTML = '<nav><a href="/login">Login</a></nav>';
    resolveViewer2(
      jsonRes({ data: { Viewer: { id: 100, name: 'Alice', mediaListOptions: { scoreFormat: 'POINT_10' } } } })
    );
    expect(await viewerPromise2).toBeNull();
    expect(helpers.store.get('al_user_id', null)).toBeNull();
  });

  it('does not spam bridge.clear() from syncFromPage() when already logged out, while direct clearViewer() stays unconditional', async () => {
    const { bus, helpers, anilist } = await loadFreshAniList();
    const clearSpy = vi.fn();
    const clearAuthSpy = vi.fn();

    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => undefined,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: clearSpy,
      clearAuth: clearAuthSpy
    });

    document.body.innerHTML = '<nav><a href="/login">Login</a></nav>';

    expect(anilist.AniList.hasAuth()).toBe(false);
    expect(anilist.AniList.hasAuth()).toBe(false);
    anilist.AniList.session.syncFromPage?.();
    expect(clearSpy).toHaveBeenCalledTimes(0);

    helpers.store.set('al_token_auth', 'Bearer xyz');
    expect(anilist.AniList.hasAuth()).toBe(false);
    expect(anilist.AniList.hasAuth()).toBe(false);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearAuthSpy).toHaveBeenCalledTimes(1);

    anilist.AniList.clearViewer();
    expect(clearSpy).toHaveBeenCalledTimes(2);
    expect(clearAuthSpy).toHaveBeenCalledTimes(2);
  });

  it('clears caches and session keys on 401/unauthenticated response', async () => {
    const { helpers, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    helpers.store.set('al_username', 'Alice');
    helpers.store.set('al_token_auth', 'Bearer stale');

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 55, title: { romaji: 'Show' } } } }))
      .mockResolvedValueOnce(jsonRes({ errors: [{ message: 'Invalid token' }] }, 401))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 55, title: { romaji: 'Fresh' } } } }));

    await anilist.AniList.query('query ($id: Int) { Media(id: $id) { id title { romaji } } }', { id: 55 });

    await expect(anilist.AniList.query('query { Viewer { id } }', {}, 0)).rejects.toMatchObject({
      auth: 'AniList'
    });
    expect(helpers.store.get('al_username', null)).toBeNull();
    expect(helpers.store.get('al_token_auth', null)).toBeNull();

    const fresh = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id title { romaji } } }',
      { id: 55 }
    );
    expect(fresh.Media.title.romaji).toBe('Fresh');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('AniList API — B1-11: Cache epoch, inflightExact race, lazy onGqlFetch & gqlStore copy removal', () => {
  it('prevents in-flight query resolving after invalidate() from serving stale inflightExact, poisoning entityCache, or deleting newer inflightExact', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    let resolveOld!: (res: Response) => void;
    let resolveNew!: (res: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((r) => (resolveOld = r)))
      .mockImplementationOnce(() => new Promise<Response>((r) => (resolveNew = r)));

    const q = 'query ($id: Int) { Media(id: $id) { id title { romaji } } }';
    const oldPromise = anilist.AniList.query(q, { id: 10 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    anilist.AniList.invalidate();

    const newPromise1 = anilist.AniList.query(q, { id: 10 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    resolveOld(jsonRes({ data: { Media: { id: 10, title: { romaji: 'Stale' } } } }));
    expect(await oldPromise).toEqual({ Media: { id: 10, title: { romaji: 'Stale' } } });

    const newPromise2 = anilist.AniList.query(q, { id: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveNew(jsonRes({ data: { Media: { id: 10, title: { romaji: 'Fresh' } } } }));
    const [r1, r2] = await Promise.all([newPromise1, newPromise2]);
    expect(r1).toEqual({ Media: { id: 10, title: { romaji: 'Fresh' } } });
    expect(r2).toEqual({ Media: { id: 10, title: { romaji: 'Fresh' } } });

    const cached = await anilist.AniList.query(q, { id: 10 });
    expect(cached).toEqual({ Media: { id: 10, title: { romaji: 'Fresh' } } });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    let resolveM10a!: (r: Response) => void;
    let resolveM10b!: (r: Response) => void;
    let resolveM20!: (r: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((r) => (resolveM10a = r)))
      .mockImplementationOnce(() => new Promise<Response>((r) => (resolveM20 = r)))
      .mockImplementationOnce(() => new Promise<Response>((r) => (resolveM10b = r)));

    const p10a = anilist.AniList.query(q, { id: 10 }, { forceFresh: true });
    const p20a = anilist.AniList.query(q, { id: 20 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    anilist.AniList.invalidate('Media:10');

    const p20b = anilist.AniList.query(q, { id: 20 });
    const p10b = anilist.AniList.query(q, { id: 10 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    resolveM10a(jsonRes({ data: { Media: { id: 10, title: { romaji: 'Old10' } } } }));
    resolveM20(jsonRes({ data: { Media: { id: 20, title: { romaji: 'Fresh20' } } } }));
    resolveM10b(jsonRes({ data: { Media: { id: 10, title: { romaji: 'New10' } } } }));

    expect(await p10a).toEqual({ Media: { id: 10, title: { romaji: 'Old10' } } });
    expect(await p10b).toEqual({ Media: { id: 10, title: { romaji: 'New10' } } });
    expect(await p20a).toEqual({ Media: { id: 20, title: { romaji: 'Fresh20' } } });
    expect(await p20b).toEqual({ Media: { id: 20, title: { romaji: 'Fresh20' } } });
  });

  it('attaches CoreHooks.onGqlFetch lazily on query, invalidates on external mutation, and unsubscribes when caches & inflight drain', async () => {
    const { bus, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(false);

    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await expect(anilist.AniList.query('query { GenreCollection }', {}, 0)).rejects.toThrow();
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(false);

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 77, title: { romaji: 'Old' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 77, title: { romaji: 'Updated' } } } }));

    const q = 'query ($id: Int) { Media(id: $id) { id title { romaji } } }';
    await anilist.AniList.query(q, { id: 77 });
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(true);

    bus.CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: '# mutation ignored\nquery { Media(id: 77, search: "mutation") { id } }',
      variables: {}
    });
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(true);
    const stillCached = await anilist.AniList.query(q, { id: 77 });
    expect(stillCached.Media.title.romaji).toBe('Old');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    bus.CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { SaveMediaListEntry(mediaId: 77, progress: 5) { id } }',
      variables: { mediaId: 77 }
    });
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(false);

    const fresh = await anilist.AniList.query(q, { id: 77 });
    expect(fresh.Media.title.romaji).toBe('Updated');
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(true);

    anilist.AniList.invalidate();
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(false);
  });

  it('does not copy gqlStore entries into entityCache during getMediaList() and guards null lists/entries', async () => {
    const { bus, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const gqlStore = new Map<string, any>();
    const mlcWithNulls = {
      user: { id: 500, name: 'Alice' },
      lists: [
        null,
        {
          name: 'Watching',
          isCustomList: false,
          status: 'CURRENT',
          entries: [
            null,
            { id: 1, mediaId: 42, status: 'CURRENT', score: 8, progress: 3, media: { id: 42, idMal: null } }
          ]
        }
      ]
    };

    gqlStore.set('gql:MediaListCollection:ANIME:500:{}', encodeGqlSnap({ data: { MediaListCollection: mlcWithNulls } }));

    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => gqlStore,
      getRpcCache: () => undefined,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: () => gqlStore.clear(),
      clearAuth: () => {}
    });

    const cachedRes = await anilist.AniList.getMediaList(500, 'ANIME');
    expect(cachedRes.allEntries).toHaveLength(1);
    expect(cachedRes.allEntries[0].mediaId).toBe(42);
    expect(cachedRes.lists).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();

    gqlStore.clear();
    fetchMock.mockResolvedValueOnce(
      jsonRes({ data: { MediaListCollection: makeMlcPayload(500, 'Alice', 99) } })
    );

    const freshRes = await anilist.AniList.getMediaList(500, 'ANIME');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(freshRes.allEntries[0].mediaId).toBe(99);
  });
});

describe('AniList API — B1-12: parseEntityMeta selection parsing & Viewer mediaListOptions defense', () => {
  it('retries once with forceFresh when cached Viewer lacks mediaListOptions and never crashes or stores undefined scoreFormat', async () => {
    const { helpers, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'Alice' } } } };

    fetchMock.mockResolvedValueOnce(jsonRes({ data: { Viewer: { id: 100, name: 'Alice' } } }));
    const minimal = await anilist.AniList.query('query { Viewer { id name } }', {});
    expect(minimal.Viewer).toEqual({ id: 100, name: 'Alice' });

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Viewer: { id: 100, name: 'Alice' } } }))
      .mockResolvedValueOnce(
        jsonRes({ data: { Viewer: { id: 100, name: 'Alice', mediaListOptions: { scoreFormat: 'POINT_10_DECIMAL' } } } })
      );

    const info = await anilist.AniList.viewer();
    expect(info).toEqual({ id: 100, name: 'Alice', scoreFormat: 'POINT_10_DECIMAL' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].cache).toBe('no-store');
    expect(helpers.store.get('al_score_format', null)).toBe('POINT_10_DECIMAL');

    anilist.AniList.clearViewer();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Viewer: { id: 100, name: 'Alice' } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Viewer: { id: 100, name: 'Alice' } } }));

    const fallbackInfo = await anilist.AniList.viewer();
    expect(fallbackInfo).toEqual({ id: 100, name: 'Alice', scoreFormat: '' });
    expect(helpers.store.get('al_score_format', 'UNSET')).toBe('UNSET');
  });

  it('does not falsely mark type as cached during MediaData.get() and avoids aliasing filtered MediaListCollection queries', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 30001, idMal: 1, format: 'MANGA', title: { romaji: 'Monster' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 30001, type: 'MANGA', title: { romaji: 'Monster' } } } }));

    const mediaEntry = await anilist.MediaData.get(30001, 'MANGA');
    expect(mediaEntry?.id).toBe(30001);

    const withType = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id type title { romaji } } }',
      { id: 30001 }
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(withType.Media.type).toBe('MANGA');

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(500, 'Alice', 11) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(500, 'Alice', 22) } }));

    await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType, $status: MediaListStatus) { MediaListCollection(userId: $userId, type: $type, status: $status) { lists { entries { id mediaId } } } }',
      { userId: 500, type: 'ANIME', status: 'COMPLETED' }
    );

    const fullList = await anilist.AniList.getMediaList(500, 'ANIME');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fullList.allEntries[0].mediaId).toBe(22);
  });
});

describe('AniList API — B1-13 & B1-14: Exact key matching, hasNextChunk rejection, and case normalization', () => {
  it('never collides usernames "anime" / "manga" and rejects chunked/filtered :{...} keys and hasNextChunk payloads', async () => {
    const { bus, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const gqlStore = new Map<string, any>();
    const rpcCache = new Map<string, any>();
    const rpcInflight = new Map<string, { promise: Promise<any> }>();

    gqlStore.set('gql:MediaListCollection:ANIME:otheruser:{}', encodeGqlSnap({ data: { MediaListCollection: makeMlcPayload(9, 'otheruser', 901) } }));
    gqlStore.set('gql:MediaListCollection:ANIME:anime:{"chunk":1,"perChunk":500}', encodeGqlSnap({ data: { MediaListCollection: makeMlcPayload(7, 'anime', 701) } }));
    gqlStore.set('gql:MediaListCollection:ANIME:alice:{}', encodeGqlSnap({ data: { MediaListCollection: makeMlcPayload(8, 'alice', 801, { hasNextChunk: true }) } }));

    rpcCache.set('rpc:MediaListCollection:MANGA:otheruser:{}', {
      time: Date.now(),
      msg: { result: { MediaListCollection: makeMlcPayload(9, 'otheruser', 902) } }
    });
    rpcCache.set('rpc:MediaListCollection:ANIME:anime:{"status":"COMPLETED"}', {
      time: Date.now(),
      msg: { result: { MediaListCollection: makeMlcPayload(7, 'anime', 702) } }
    });
    rpcCache.set('rpc:MediaListCollection:ANIME:alice:{}', {
      time: Date.now(),
      msg: { result: { MediaListCollection: makeMlcPayload(8, 'alice', 802, { hasNextChunk: true }) } }
    });

    rpcInflight.set('rpc:MediaListCollection:ANIME:otheruser:{}', {
      promise: Promise.resolve({ result: { MediaListCollection: makeMlcPayload(9, 'otheruser', 903) } })
    });
    rpcInflight.set('rpc:MediaListCollection:ANIME:alice:{"chunk":2}', {
      promise: Promise.resolve({ result: { MediaListCollection: makeMlcPayload(8, 'alice', 803) } })
    });

    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => gqlStore,
      getRpcCache: () => rpcCache,
      getRpcInflight: () => rpcInflight,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: () => {},
      clearAuth: () => {}
    });

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(7, 'anime', 777) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(10, 'manga', 888) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(8, 'alice', 999) } }));

    const animeUser = await anilist.AniList.getMediaList('anime', 'ANIME');
    expect(animeUser.allEntries[0].mediaId).toBe(777);

    const mangaUser = await anilist.AniList.getMediaList('manga', 'MANGA');
    expect(mangaUser.allEntries[0].mediaId).toBe(888);

    const aliceUser = await anilist.AniList.getMediaList('alice', 'ANIME');
    expect(aliceUser.allEntries[0].mediaId).toBe(999);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    anilist.AniList.invalidate();
    gqlStore.set('gql:MediaListCollection:ANIME:anime:{}', encodeGqlSnap({ data: { MediaListCollection: makeMlcPayload(7, 'anime', 7000) } }));
    const animeHit = await anilist.AniList.getMediaList('anime', 'ANIME');
    expect(animeHit.allEntries[0].mediaId).toBe(7000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('normalizes mixed-case options.userName and tolerates mixed-case idMap / userMap / rpcCache keys', async () => {
    const { bus, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const userMap = new Map<string, number>([['MysticDaiya', 7053169]]);
    const idMap = new Map<number, string>([[7053169, 'MysticDaiya']]);
    const rpcCache = new Map<string, any>([
      [
        'rpc:MediaListCollection:ANIME:MysticDaiya:{}',
        {
          time: Date.now(),
          msg: { result: { MediaListCollection: makeMlcPayload(7053169, 'MysticDaiya', 1234) } }
        }
      ]
    ]);

    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => rpcCache,
      getRpcInflight: () => undefined,
      getUserMap: () => userMap,
      getIdMap: () => idMap,
      clear: () => {},
      clearAuth: () => {}
    });

    const resById = await anilist.AniList.getMediaList(7053169, 'ANIME');
    expect(resById.allEntries[0].mediaId).toBe(1234);

    const resByOpts = await anilist.AniList.getMediaList('MysticDaiya', 'ANIME', { userName: '  MysticDaiya  ' });
    expect(resByOpts.allEntries[0].mediaId).toBe(1234);

    rpcCache.clear();
    const gqlStore = new Map<string, any>([
      ['gql:MediaListCollection:ANIME:7053169:{}', encodeGqlSnap({ data: { MediaListCollection: makeMlcPayload(7053169, 'MysticDaiya', 5678) } })]
    ]);
    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => gqlStore,
      getRpcCache: () => rpcCache,
      getRpcInflight: () => undefined,
      getUserMap: () => userMap,
      getIdMap: () => idMap,
      clear: () => {},
      clearAuth: () => {}
    });

    const resViaUserMap = await anilist.AniList.getMediaList('target', 'ANIME', { userName: 'MysticDaiya' });
    expect(resViaUserMap.allEntries[0].mediaId).toBe(5678);

    gqlStore.clear();
    anilist.AniList.invalidate();
    const rpcInflight = new Map<string, { promise: Promise<any> }>([
      [
        'rpc:MediaListCollection:ANIME:MysticDaiya:{}',
        { promise: Promise.resolve({ result: { MediaListCollection: makeMlcPayload(7053169, 'MysticDaiya', 9123) } }) }
      ]
    ]);
    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => undefined,
      getRpcInflight: () => rpcInflight,
      getUserMap: () => userMap,
      getIdMap: () => idMap,
      clear: () => {},
      clearAuth: () => {}
    });

    const resViaInflight = await anilist.AniList.getMediaList(7053169, 'ANIME');
    expect(resViaInflight.allEntries[0].mediaId).toBe(9123);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AniList API — B1-15: FastLoadCacheBridge fault isolation', () => {
  it('degrades cleanly to network fetch when FastLoadCacheBridge getters or Map methods throw, and never breaks invalidate / mutation / MediaData.save', async () => {
    const { bus, anilist } = await loadFreshAniList();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const throwingMap = new Proxy(new Map(), {
      get() {
        throw new Error('corrupt map');
      }
    });

    const unsubBridge = bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => throwingMap as any,
      getRpcCache: () => {
        throw new Error('rpc cache boom');
      },
      getRpcInflight: () => throwingMap as any,
      getUserMap: () => {
        throw new Error('userMap boom');
      },
      getIdMap: () => throwingMap as any,
      clear: () => {
        throw new Error('bridge clear boom');
      },
      clearAuth: () => {
        throw new Error('bridge clearAuth boom');
      }
    });

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(42, 'Bob', 321) } }))
      .mockResolvedValueOnce(jsonRes({ data: { SaveMediaListEntry: { score: 9, progress: 12, status: 'COMPLETED' } } }))
      .mockResolvedValueOnce(jsonRes({ data: { SaveMediaListEntry: { score: 10, progress: 12, status: 'COMPLETED' } } }));

    const listRes = await anilist.AniList.getMediaList(42, 'ANIME');
    expect(listRes.allEntries[0].mediaId).toBe(321);

    expect(() => anilist.AniList.invalidate()).not.toThrow();
    expect(() => anilist.AniList.clearViewer()).not.toThrow();

    const mutRes = await anilist.AniList.query('mutation { SaveMediaListEntry(mediaId: 321) { score } }', {});
    expect(mutRes.SaveMediaListEntry.score).toBe(9);

    const saved = await anilist.MediaData.save(321, 'ANIME', { score: 10, progress: 12, status: 'COMPLETED' });
    expect(saved?.score).toBe(10);

    unsubBridge();
    (window as any).__ALFL_CLEAR__ = () => {
      throw new Error('global clear boom');
    };
    expect(() => anilist.AniList.invalidate()).not.toThrow();
    errSpy.mockRestore();
  });
});

describe('AniList API — B2-03: No dangling CoreHooks.onGqlFetch subscription on FastLoad cache hits', () => {
  it('leaves CoreHooks.hasGqlFetchSubscribers() === false when getMediaList() hits gqlStore, rpcCache, or rpcInflight with empty entityCache', async () => {
    const { bus, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(false);

    const gqlStore = new Map<string, any>([
      ['gql:MediaListCollection:ANIME:501:{}', encodeGqlSnap({ data: { MediaListCollection: makeMlcPayload(501, 'Alice', 11) } })]
    ]);
    const rpcCache = new Map<string, any>([
      [
        'rpc:MediaListCollection:MANGA:502:{}',
        { time: Date.now(), msg: { result: { MediaListCollection: makeMlcPayload(502, 'Bob', 22) } } }
      ]
    ]);
    const rpcInflight = new Map<string, { promise: Promise<any> }>([
      [
        'rpc:MediaListCollection:ANIME:503:{}',
        { promise: Promise.resolve({ result: { MediaListCollection: makeMlcPayload(503, 'Carol', 33) } }) }
      ]
    ]);

    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => gqlStore,
      getRpcCache: () => rpcCache,
      getRpcInflight: () => rpcInflight,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: () => {},
      clearAuth: () => {}
    });

    const gqlRes = await anilist.AniList.getMediaList(501, 'ANIME');
    expect(gqlRes.allEntries[0].mediaId).toBe(11);
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(false);

    const rpcRes = await anilist.AniList.getMediaList(502, 'MANGA');
    expect(rpcRes.allEntries[0].mediaId).toBe(22);
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(false);

    const inflightRes = await anilist.AniList.getMediaList(503, 'ANIME');
    expect(inflightRes.allEntries[0].mediaId).toBe(33);
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 88, title: { romaji: 'First' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 88, title: { romaji: 'Second' } } } }));

    await anilist.AniList.query('query ($id: Int) { Media(id: $id) { id title { romaji } } }', { id: 88 });
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(true);

    bus.CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { SaveMediaListEntry(mediaId: 88, progress: 1) { id } }',
      variables: { mediaId: 88 }
    });
    expect(bus.CoreHooks.hasGqlFetchSubscribers()).toBe(false);

    const refetched = await anilist.AniList.query('query ($id: Int) { Media(id: $id) { id title { romaji } } }', { id: 88 });
    expect(refetched.Media.title.romaji).toBe('Second');
  });
});

describe('AniList API — B2-04: Path-scoped selection matching & strict bound-variable checks', () => {
  it('distinguishes nested field paths from top-level/sibling paths across Media, MediaListCollection, and Viewer', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 101, mediaListEntry: { status: 'CURRENT', score: 8 } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 101, status: 'RELEASING' } } }));

    await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id mediaListEntry { status score } } }',
      { id: 101 }
    );

    const nestedSubset = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id mediaListEntry { status } } }',
      { id: 101 }
    );
    expect(nestedSubset.Media.mediaListEntry.status).toBe('CURRENT');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const topLevelStatus = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id status } }',
      { id: 101 }
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(topLevelStatus.Media.status).toBe('RELEASING');

    fetchMock
      .mockResolvedValueOnce(
        jsonRes({
          data: {
            MediaListCollection: {
              user: { id: 500 },
              lists: [{ name: 'Watching', status: 'CURRENT', entries: [{ id: 1, mediaId: 10 }] }]
            }
          }
        })
      )
      .mockResolvedValueOnce(
        jsonRes({
          data: {
            MediaListCollection: {
              user: { id: 500, name: 'Alice' },
              lists: [{ name: 'Watching', status: 'CURRENT', entries: [{ id: 1, mediaId: 10 }] }]
            }
          }
        })
      )
      .mockResolvedValueOnce(
        jsonRes({
          data: {
            MediaListCollection: {
              user: { id: 500, name: 'Alice' },
              lists: [{ name: 'Watching', status: 'CURRENT', entries: [{ id: 1, mediaId: 10, status: 'CURRENT' }] }]
            }
          }
        })
      )
      .mockResolvedValueOnce(
        jsonRes({
          data: {
            MediaListCollection: {
              user: { id: 500, name: 'Alice' },
              lists: [{ name: 'Watching', status: 'CURRENT', entries: [{ id: 1, mediaId: 10, media: { status: 'FINISHED' } }] }]
            }
          }
        })
      );

    await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { user { id } lists { name status entries { id mediaId } } } }',
      { userId: 500, type: 'ANIME' }
    );

    const withUserName = await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { user { id name } lists { name status entries { id mediaId } } } }',
      { userId: 500, type: 'ANIME' }
    );
    expect(withUserName.MediaListCollection.user.name).toBe('Alice');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const withEntryStatus = await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { lists { entries { id status } } } }',
      { userId: 500, type: 'ANIME' }
    );
    expect(withEntryStatus.MediaListCollection.lists[0].entries[0].status).toBe('CURRENT');
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const withMediaStatus = await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { lists { entries { id media { status } } } } }',
      { userId: 500, type: 'ANIME' }
    );
    expect(withMediaStatus.MediaListCollection.lists[0].entries[0].media.status).toBe('FINISHED');
    expect(fetchMock).toHaveBeenCalledTimes(6);

    (window as any).__NUXT__ = { state: { auth: { user: { id: 500, name: 'Alice' } } } };
    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Viewer: { id: 500, name: 'Alice', mediaListOptions: { rowOrder: 'score' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Viewer: { id: 500, name: 'Alice', mediaListOptions: { scoreFormat: 'POINT_10' } } } }));

    await anilist.AniList.query('query { Viewer { id name mediaListOptions { rowOrder } } }', {});
    const viewerInfo = await anilist.AniList.viewer();
    expect(viewerInfo).toEqual({ id: 500, name: 'Alice', scoreFormat: 'POINT_10' });
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('rejects unbound vars in MediaListCollection and Media so unused vars never mis-key entityCache', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(1, 'alice', 111) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(999, 'bob', 999) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(1, 'alice', 112) } }));

    await anilist.AniList.query(
      'query ($userName: String) { MediaListCollection(userName: $userName, type: ANIME) { user { id name } lists { entries { id mediaId } } } }',
      { userName: 'alice', userId: 999 }
    );

    const bobList = await anilist.AniList.getMediaList(999, 'ANIME');
    expect(bobList.allEntries[0].mediaId).toBe(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const aliceList = await anilist.AniList.getMediaList('alice', 'ANIME');
    expect(aliceList.allEntries[0].mediaId).toBe(112);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(1, 'me', 201) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(1, 'me', 202) } }));

    await anilist.AniList.query(
      'query { MediaListCollection(type: ANIME) { user { id name } lists { entries { id mediaId } } } }',
      { type: 'MANGA' }
    );

    const mangaMe = await anilist.AniList.query(
      'query { MediaListCollection(type: MANGA) { user { id name } lists { entries { id mediaId } } } }',
      {}
    );
    expect(mangaMe.MediaListCollection.lists[0].entries[0].mediaId).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 300, title: { romaji: 'UnboundVarMedia' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 300, title: { romaji: 'FreshMedia' } } } }));

    await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id title { romaji } } }',
      { id: 300, type: 'MANGA' }
    );
    const freshMedia = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id title { romaji } } }',
      { id: 300 }
    );
    expect(freshMedia.Media.title.romaji).toBe('FreshMedia');
    expect(fetchMock).toHaveBeenCalledTimes(7);

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 301 } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 301 } } }));
    await anilist.AniList.query('query ($id: Int) { Media(id: $id) { id title { } } }', { id: 301 });
    await anilist.AniList.query('query ($id: Int) { Media(id: $id) { id } }', { id: 301 });
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });
});

describe('AniList API — B2-05: Cold-session mid-flight account switch defense in AniList.viewer()', () => {
  it('clears state, returns null, and avoids writing User A to store when __NUXT__ switches mid-flight on a cold session', async () => {
    const { bus, helpers, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const clearAuthSpy = vi.fn();
    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => undefined,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: () => {},
      clearAuth: clearAuthSpy
    });

    (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'Alice' } } } };

    let resolveUserA!: (res: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveUserA = resolve;
        })
    );

    const viewerPromise = anilist.AniList.viewer();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    (window as any).__NUXT__ = { state: { auth: { user: { id: 200, name: 'Bob' } } } };

    resolveUserA(
      jsonRes({ data: { Viewer: { id: 100, name: 'Alice', mediaListOptions: { scoreFormat: 'POINT_10' } } } })
    );

    expect(await viewerPromise).toBeNull();
    expect(clearAuthSpy).toHaveBeenCalledTimes(1);
    expect(helpers.store.get('al_user_id', null)).toBeNull();
    expect(helpers.store.get('al_username', null)).toBeNull();
    expect(helpers.store.get('al_score_format', null)).toBeNull();

    fetchMock.mockResolvedValueOnce(
      jsonRes({ data: { Viewer: { id: 200, name: 'Bob', mediaListOptions: { scoreFormat: 'POINT_100' } } } })
    );
    const bob = await anilist.AniList.viewer();
    expect(bob).toEqual({ id: 200, name: 'Bob', scoreFormat: 'POINT_100' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('catches mid-flight navbar account switch even when cacheEpoch invalidation skipped entityCache.set("Viewer") and during retry', async () => {
    const { bus, helpers, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const clearAuthSpy = vi.fn();
    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => undefined,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: () => {},
      clearAuth: clearAuthSpy
    });

    document.body.innerHTML = '<nav><a href="/user/Alice">Alice</a></nav>';

    let resolveFirst!: (res: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const p1 = anilist.AniList.viewer();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    anilist.AniList.invalidate();
    document.body.innerHTML = '<nav><a href="/user/Bob">Bob</a></nav>';

    resolveFirst(
      jsonRes({ data: { Viewer: { id: 100, name: 'Alice', mediaListOptions: { scoreFormat: 'POINT_10' } } } })
    );

    expect(await p1).toBeNull();
    expect(clearAuthSpy).toHaveBeenCalledTimes(1);
    expect(helpers.store.get('al_user_id', null)).toBeNull();
    expect(helpers.store.get('al_username', null)).toBeNull();
    expect(helpers.store.get('al_score_format', null)).toBeNull();

    document.body.innerHTML = '<nav><a href="/user/Alice">Alice</a></nav>';
    let resolveRetry!: (res: Response) => void;
    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Viewer: { id: 100, name: 'Alice' } } }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRetry = resolve;
          })
      );

    const p2 = anilist.AniList.viewer();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    anilist.AniList.invalidate();
    document.body.innerHTML = '<nav><a href="/user/Bob">Bob</a></nav>';
    resolveRetry(
      jsonRes({ data: { Viewer: { id: 100, name: 'Alice', mediaListOptions: { scoreFormat: 'POINT_5' } } } })
    );

    expect(await p2).toBeNull();
    expect(clearAuthSpy).toHaveBeenCalledTimes(2);
    expect(helpers.store.get('al_user_id', null)).toBeNull();
    expect(helpers.store.get('al_username', null)).toBeNull();
    expect(helpers.store.get('al_score_format', null)).toBeNull();
  });
});

describe('AniList API — B3-01: Parameterized subfields and @directives bypass entityCache', () => {
  it('bypasses entityCache for parameterized subfields (including object args) while deduping exact concurrent queries via inflightExact', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 101, description: '<p>HTML</p>' } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 101, description: 'Plain' } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 101, description: 'Markdown' } } }));

    const htmlRes = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id description(asHtml: true) } }',
      { id: 101 }
    );
    expect(htmlRes.Media.description).toBe('<p>HTML</p>');

    const plainRes = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id description } }',
      { id: 101 }
    );
    expect(plainRes.Media.description).toBe('Plain');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const falseRes = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id description(asHtml: false) } }',
      { id: 101 }
    );
    expect(falseRes.Media.description).toBe('Markdown');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 102, reviews: [{ id: 999 }] } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 102, reviews: [{ id: 1 }, { id: 2 }] } } }));

    const filteredReviews = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id reviews(filter: { score: 10 }) { id } } }',
      { id: 102 }
    );
    expect(filteredReviews.Media.reviews).toEqual([{ id: 999 }]);

    const allReviews = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id reviews { id } } }',
      { id: 102 }
    );
    expect(allReviews.Media.reviews).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    fetchMock
      .mockResolvedValueOnce(
        jsonRes({
          data: {
            MediaListCollection: {
              lists: [{ name: 'Completed', entries: [{ id: 1, mediaId: 10, score: 95 }] }]
            }
          }
        })
      )
      .mockResolvedValueOnce(
        jsonRes({
          data: {
            MediaListCollection: {
              lists: [{ name: 'Completed', entries: [{ id: 1, mediaId: 10, score: 9.5 }] }]
            }
          }
        })
      );

    const p100 = await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { lists { entries { id mediaId score(format: POINT_100) } } } }',
      { userId: 500, type: 'ANIME' }
    );
    expect(p100.MediaListCollection.lists[0].entries[0].score).toBe(95);

    const rawScore = await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { lists { entries { id mediaId score } } } }',
      { userId: 500, type: 'ANIME' }
    );
    expect(rawScore.MediaListCollection.lists[0].entries[0].score).toBe(9.5);
    expect(fetchMock).toHaveBeenCalledTimes(7);

    let resolveInflight!: (res: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveInflight = resolve;
          })
      )
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 103, description: '<p>Refetched</p>' } } }));

    const exactQ = 'query ($id: Int) { Media(id: $id) { id description(asHtml: true) } }';
    const pA = anilist.AniList.query(exactQ, { id: 103 });
    const pB = anilist.AniList.query(exactQ, { id: 103 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));

    resolveInflight(jsonRes({ data: { Media: { id: 103, description: '<p>Deduped</p>' } } }));
    const [resA, resB] = await Promise.all([pA, pB]);
    expect(resA.Media.description).toBe('<p>Deduped</p>');
    expect(resB.Media.description).toBe('<p>Deduped</p>');
    expect(fetchMock).toHaveBeenCalledTimes(8);

    const afterSettle = await anilist.AniList.query(exactQ, { id: 103 });
    expect(afterSettle.Media.description).toBe('<p>Refetched</p>');
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it('bypasses entityCache for subfield, root-field, and operation-header @directives in both directions', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 201 } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 201, bannerImage: 'https://img/201.jpg' } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 202 } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 202, siteUrl: 'https://anilist.co/anime/202' } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: null } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 203, title: { romaji: 'Real 203' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Viewer: null } }))
      .mockResolvedValueOnce(jsonRes({ data: { Viewer: { id: 100, name: 'Alice' } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 204, title: { romaji: 'CachedOpDir' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 204, title: { romaji: 'Fresh 204' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 204 } } }));

    const skippedField = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id bannerImage @skip(if: true) } }',
      { id: 201 }
    );
    expect(skippedField.Media.bannerImage).toBeUndefined();

    const withBanner = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id bannerImage } }',
      { id: 201 }
    );
    expect(withBanner.Media.bannerImage).toBe('https://img/201.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await anilist.AniList.query('query ($id: Int) { Media(id: $id) { id siteUrl @custom } }', { id: 202 });
    const withSiteUrl = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id siteUrl } }',
      { id: 202 }
    );
    expect(withSiteUrl.Media.siteUrl).toBe('https://anilist.co/anime/202');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const skippedRoot = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) @skip(if: true) { id title { romaji } } }',
      { id: 203 }
    );
    expect(skippedRoot.Media).toBeNull();

    const realRoot = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id title { romaji } } }',
      { id: 203 }
    );
    expect(realRoot.Media.title.romaji).toBe('Real 203');
    expect(fetchMock).toHaveBeenCalledTimes(6);

    const skippedViewer = await anilist.AniList.query('query { Viewer @include(if: false) { id name } }', {});
    expect(skippedViewer.Viewer).toBeNull();
    const realViewer = await anilist.AniList.query('query { Viewer { id name } }', {});
    expect(realViewer.Viewer).toEqual({ id: 100, name: 'Alice' });
    expect(fetchMock).toHaveBeenCalledTimes(8);

    await anilist.AniList.query('query @cached { Media(id: 204) { id title { romaji } } }', {});
    const fresh204 = await anilist.AniList.query('query { Media(id: 204) { id title { romaji } } }', {});
    expect(fresh204.Media.title.romaji).toBe('Fresh 204');
    expect(fetchMock).toHaveBeenCalledTimes(10);

    const directedAfterCache = await anilist.AniList.query(
      'query ($id: Int) { Media(id: $id) { id title @skip(if: true) { romaji } } }',
      { id: 204 }
    );
    expect(directedAfterCache.Media.title).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });
});

describe('AniList API — B3-02: Strict MediaListCollection type & userId/userName/Media.id validation', () => {
  it('does not cache MediaListCollection queries omitting type or passing undefined/null type onto MediaListCollection:ANIME', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(500, 'Alice', 9001) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(500, 'Alice', 1001) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(501, 'Bob', 9002) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(501, 'Bob', 1002) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(502, 'Carol', 9003) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(502, 'Carol', 1003) } }));

    await anilist.AniList.query(
      'query ($userId: Int) { MediaListCollection(userId: $userId) { user { id name } lists { name entries { id mediaId } } } }',
      { userId: 500 }
    );
    const anime500 = await anilist.AniList.getMediaList(500, 'ANIME');
    expect(anime500.allEntries[0].mediaId).toBe(1001);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { user { id name } lists { entries { id mediaId } } } }',
      { userId: 501, type: undefined }
    );
    const anime501 = await anilist.AniList.getMediaList(501, 'ANIME');
    expect(anime501.allEntries[0].mediaId).toBe(1002);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { user { id name } lists { entries { id mediaId } } } }',
      { userId: 502, type: null }
    );
    const anime502 = await anilist.AniList.getMediaList(502, 'ANIME');
    expect(anime502.allEntries[0].mediaId).toBe(1003);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('rejects invalid MediaListCollection userId/userName without poisoning "me", while preserving valid "me" and getMediaList caching', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const mlcByVarQuery =
      'query ($userId: Int, $userName: String, $type: MediaType) { MediaListCollection(userId: $userId, userName: $userName, type: $type) { user { id name } lists { entries { id mediaId } } } }';
    const mlcMeQuery =
      'query { MediaListCollection(type: ANIME) { lists { entries { id mediaId } } } }';

    fetchMock.mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(1, 'me', 111) } }));
    await anilist.AniList.query(mlcByVarQuery, { userId: undefined, userName: undefined, type: 'ANIME' });
    const meCached = await anilist.AniList.query(mlcMeQuery, {});
    expect(meCached.MediaListCollection.lists[0].entries[0].mediaId).toBe(111);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    anilist.AniList.invalidate();
    for (let i = 0; i < 8; i++) {
      fetchMock.mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(999, 'bad', 800 + i) } }));
    }
    fetchMock.mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(1, 'me', 222) } }));

    await anilist.AniList.query(mlcByVarQuery, { userId: 0, type: 'ANIME' });
    await anilist.AniList.query('query { MediaListCollection(userId: 0, type: ANIME) { lists { entries { id mediaId } } } }', {});
    await anilist.AniList.query(mlcByVarQuery, { userId: -1, type: 'ANIME' });
    await anilist.AniList.query(mlcByVarQuery, { userId: 1.5, type: 'ANIME' });
    await anilist.AniList.query(mlcByVarQuery, { userId: '500', type: 'ANIME' });
    await anilist.AniList.query(mlcByVarQuery, { userName: '   ', type: 'ANIME' });
    await anilist.AniList.query(mlcByVarQuery, { userName: '', type: 'ANIME' });
    await anilist.AniList.query(mlcByVarQuery, { userName: 123, type: 'ANIME' });

    const freshMe = await anilist.AniList.query(mlcMeQuery, {});
    expect(freshMe.MediaListCollection.lists[0].entries[0].mediaId).toBe(222);
    expect(fetchMock).toHaveBeenCalledTimes(10);

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(500, 'Alice', 555) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(600, 'Bob', 666) } }));

    const list500a = await anilist.AniList.getMediaList(500, 'ANIME');
    const list500b = await anilist.AniList.getMediaList(500, 'ANIME');
    expect(list500a.allEntries[0].mediaId).toBe(555);
    expect(list500b.allEntries[0].mediaId).toBe(555);

    const listBobA = await anilist.AniList.getMediaList('Bob', 'ANIME');
    const listBobB = await anilist.AniList.getMediaList('bob', 'ANIME');
    expect(listBobA.allEntries[0].mediaId).toBe(666);
    expect(listBobB.allEntries[0].mediaId).toBe(666);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it('rejects non-positive, non-integer, and string Media.id values from entityCache keying while caching valid ids', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const q = 'query ($id: Int) { Media(id: $id) { id title { romaji } } }';
    for (let i = 0; i < 8; i++) {
      fetchMock.mockResolvedValueOnce(jsonRes({ data: { Media: { id: 123, title: { romaji: `Invalid-${i}` } } } }));
    }
    fetchMock.mockResolvedValueOnce(jsonRes({ data: { Media: { id: 123, title: { romaji: 'Valid-123' } } } }));

    await anilist.AniList.query(q, { id: -1 });
    await anilist.AniList.query(q, { id: -1 });
    await anilist.AniList.query(q, { id: 0 });
    await anilist.AniList.query(q, { id: 0 });
    await anilist.AniList.query(q, { id: 1.5 });
    await anilist.AniList.query(q, { id: 1.5 });
    await anilist.AniList.query(q, { id: '123' as any });
    await anilist.AniList.query(q, { id: '123' as any });

    const valid1 = await anilist.AniList.query(q, { id: 123 });
    const valid2 = await anilist.AniList.query(q, { id: 123 });
    expect(valid1.Media.title.romaji).toBe('Valid-123');
    expect(valid2.Media.title.romaji).toBe('Valid-123');
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });
});

describe('AniList API — Session peek(), getters, recordHint() & document-start safety', () => {
  it('reads session purely via peek() and live getters without triggering bridge.clear() or clearing storage', async () => {
    const { bus, helpers, anilist } = await loadFreshAniList();
    const clearSpy = vi.fn();
    const clearAuthSpy = vi.fn();

    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => undefined,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: clearSpy,
      clearAuth: clearAuthSpy
    });

    helpers.store.set('al_user_id', 100);
    helpers.store.set('al_username', 'Alice');
    helpers.store.set('al_score_format', 'POINT_10');

    expect(anilist.AniList.session.peek()).toEqual({
      userId: 100,
      username: 'Alice',
      scoreFormat: 'POINT_10'
    });
    expect(anilist.AniList.session.userId).toBe(100);
    expect(anilist.AniList.session.username).toBe('Alice');
    expect(anilist.AniList.session.scoreFormat).toBe('POINT_10');

    document.body.innerHTML = '<nav><a href="/login">Login</a></nav>';
    expect(anilist.AniList.session.peek()).toEqual({
      userId: null,
      username: null,
      scoreFormat: null
    });
    expect(clearSpy).toHaveBeenCalledTimes(0);
    expect(helpers.store.get('al_user_id', null)).toBe(100);

    expect(anilist.AniList.session.peek({ reconcile: true })).toEqual({
      userId: null,
      username: null,
      scoreFormat: null
    });
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearAuthSpy).toHaveBeenCalledTimes(1);
    expect(helpers.store.get('al_user_id', null)).toBeNull();
  });

  it('preserves stored al_username when nuxtUser.id matches before nuxtUser.name hydrates, and survives null document.body', async () => {
    const { helpers, anilist } = await loadFreshAniList();

    helpers.store.set('al_user_id', 555);
    helpers.store.set('al_username', 'MatiX');
    helpers.store.set('al_score_format', 'POINT_10_DECIMAL');
    (window as any).__NUXT__ = { state: { auth: { user: { id: 555 } } } };

    expect(anilist.AniList.session.peek()).toEqual({
      userId: 555,
      username: 'MatiX',
      scoreFormat: 'POINT_10_DECIMAL'
    });

    (window as any).__NUXT__ = { state: { auth: { user: { id: 999, name: 'Other' } } } };
    expect(anilist.AniList.session.peek()).toEqual({
      userId: 999,
      username: 'Other',
      scoreFormat: null
    });

    const origBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      expect(() => anilist.AniList.session.peek()).not.toThrow();
      expect(anilist.AniList.session.userId).toBe(999);
    } finally {
      delete (document as any).body;
      if (!document.body && origBody) document.documentElement.appendChild(origBody);
    }
  });

  it('guards recordHint() against logged-out pages, page-user mismatches, and isSessionClearing()', async () => {
    const { bus, helpers, anilist } = await loadFreshAniList();

    document.body.innerHTML = '<nav><a href="/login">Login</a></nav>';
    anilist.AniList.session.recordHint({ userId: 100, username: 'Alice' });
    expect(helpers.store.get('al_user_id', null)).toBeNull();
    expect(helpers.store.get('al_username', null)).toBeNull();

    document.body.innerHTML = '';
    (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'Alice' } } } };
    anilist.AniList.session.recordHint({ username: 'Bob' });
    expect(helpers.store.get('al_username', null)).toBeNull();

    anilist.AniList.session.recordHint({ userId: 200, username: 'Alice' });
    expect(helpers.store.get('al_user_id', null)).toBeNull();

    bus.CoreHooks.setSessionClearing(true);
    try {
      anilist.AniList.session.recordHint({ userId: 100, username: 'Alice' });
      expect(helpers.store.get('al_user_id', null)).toBeNull();
    } finally {
      bus.CoreHooks.setSessionClearing(false);
    }

    anilist.AniList.session.recordHint({ userId: 100, username: 'Alice' });
    expect(helpers.store.get('al_user_id', null)).toBe(100);
    expect(helpers.store.get('al_username', null)).toBe('Alice');
  });
});

describe('AniList API — BUG-18..BUG-24 regressions', () => {
  it('BUG-18: separates Media entityCache entries by resolved type and bypasses cache on invalid/unresolvable explicit type', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const varQuery = 'query ($id: Int, $type: MediaType) { Media(id: $id, type: $type) { id title { romaji } } }';
    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 1, title: { romaji: 'Cowboy Bebop (Anime)' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 1, title: { romaji: 'Cowboy Bebop (Manga)' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 1, title: { romaji: 'Cowboy Bebop (Untyped)' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 2, title: { romaji: 'InvalidType-1' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 2, title: { romaji: 'InvalidType-2' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 2, title: { romaji: 'BadLit-1' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 2, title: { romaji: 'BadLit-2' } } } }));

    const anime1 = await anilist.AniList.query(varQuery, { id: 1, type: 'ANIME' });
    const manga1 = await anilist.AniList.query(varQuery, { id: 1, type: 'MANGA' });
    expect(anime1.Media.title.romaji).toBe('Cowboy Bebop (Anime)');
    expect(manga1.Media.title.romaji).toBe('Cowboy Bebop (Manga)');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const animeLiteralHit = await anilist.AniList.query(
      'query { Media(id: 1, type: ANIME) { id title { romaji } } }',
      {}
    );
    const mangaLiteralHit = await anilist.AniList.query(
      'query { Media(id: 1, type: MANGA) { id title { romaji } } }',
      {}
    );
    expect(animeLiteralHit.Media.title.romaji).toBe('Cowboy Bebop (Anime)');
    expect(mangaLiteralHit.Media.title.romaji).toBe('Cowboy Bebop (Manga)');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const untyped1 = await anilist.AniList.query('query ($id: Int) { Media(id: $id) { id title { romaji } } }', { id: 1 });
    expect(untyped1.Media.title.romaji).toBe('Cowboy Bebop (Untyped)');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await anilist.AniList.query(varQuery, { id: 2, type: 'NOVEL' as any });
    await anilist.AniList.query(varQuery, { id: 2, type: 'NOVEL' as any });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await anilist.AniList.query('query { Media(id: 2, type: NOVEL) { id title { romaji } } }', {});
    await anilist.AniList.query('query { Media(id: 2, type: NOVEL) { id title { romaji } } }', {});
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('BUG-19: matches invalidate prefixes on colon boundaries and invalidates both ANIME/MANGA when invalidateMediaList omits type', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const mediaQ = 'query ($id: Int, $type: MediaType) { Media(id: $id, type: $type) { id title { romaji } } }';
    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 1, title: { romaji: 'Anime1-Old' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 1, title: { romaji: 'Manga1-Old' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 10, title: { romaji: 'Anime10-Keep' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 1, title: { romaji: 'Anime1-New' } } } }))
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 1, title: { romaji: 'Manga1-New' } } } }));

    await anilist.AniList.query(mediaQ, { id: 1, type: 'ANIME' });
    await anilist.AniList.query(mediaQ, { id: 1, type: 'MANGA' });
    await anilist.AniList.query(mediaQ, { id: 10, type: 'ANIME' });

    anilist.AniList.invalidate('Media:1:');

    const media10 = await anilist.AniList.query(mediaQ, { id: 10, type: 'ANIME' });
    expect(media10.Media.title.romaji).toBe('Anime10-Keep');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const media1Anime = await anilist.AniList.query(mediaQ, { id: 1, type: 'ANIME' });
    const media1Manga = await anilist.AniList.query(mediaQ, { id: 1, type: 'MANGA' });
    expect(media1Anime.Media.title.romaji).toBe('Anime1-New');
    expect(media1Manga.Media.title.romaji).toBe('Manga1-New');
    expect(fetchMock).toHaveBeenCalledTimes(5);

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(1, 'alice', 101) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(1, 'alice', 102) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(2, 'alice2', 201) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(3, 'bob', 301) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(1, 'alice', 111) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(1, 'alice', 112) } }));

    await anilist.AniList.getMediaList('alice', 'ANIME');
    await anilist.AniList.getMediaList('alice', 'MANGA');
    await anilist.AniList.getMediaList('alice2', 'ANIME');
    await anilist.AniList.getMediaList('bob', 'ANIME');

    anilist.AniList.invalidateMediaList('alice');

    const alice2StillCached = await anilist.AniList.getMediaList('alice2', 'ANIME');
    const bobStillCached = await anilist.AniList.getMediaList('bob', 'ANIME');
    expect(alice2StillCached.allEntries[0].mediaId).toBe(201);
    expect(bobStillCached.allEntries[0].mediaId).toBe(301);
    expect(fetchMock).toHaveBeenCalledTimes(9);

    const aliceAnimeFresh = await anilist.AniList.getMediaList('alice', 'ANIME');
    const aliceMangaFresh = await anilist.AniList.getMediaList('alice', 'MANGA');
    expect(aliceAnimeFresh.allEntries[0].mediaId).toBe(111);
    expect(aliceMangaFresh.allEntries[0].mediaId).toBe(112);
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it('BUG-20: scales retry backoff positively from elapsed attempt when retries > 4 or non-finite', async () => {
    vi.useFakeTimers();
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(jsonRes({ errors: [{ message: 'Server busy' }] }, 502));
    }
    fetchMock.mockResolvedValueOnce(jsonRes({ data: { Media: { id: 77 } } }));

    const pending = anilist.AniList.query('query { Media(id: 77) { id } }', {}, { retries: 6 });
    await vi.runAllTimersAsync();
    const res = await pending;
    expect(res).toEqual({ Media: { id: 77 } });
    expect(fetchMock).toHaveBeenCalledTimes(7);

    const backoffDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((ms): ms is number => typeof ms === 'number' && ms >= 1000);
    expect(backoffDelays).toEqual([1500, 3000, 4500, 6000, 7500, 9000]);

    setTimeoutSpy.mockClear();
    fetchMock.mockReset();
    for (let i = 0; i < 4; i++) {
      fetchMock.mockRejectedValueOnce(new Error('offline'));
    }
    const nanRetryPromise = anilist.AniList.query('query { Media(id: 78) { id } }', {}, Number.NaN);
    const nanHandled = nanRetryPromise.catch((err) => err);
    await vi.runAllTimersAsync();
    const err = await nanHandled;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/AniList network error/);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const nanDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((ms): ms is number => typeof ms === 'number' && ms >= 1000);
    expect(nanDelays).toEqual([1500, 3000, 4500]);
  });

  it('BUG-21: normalizes lists[i].entries identically to allEntries in parseRpcMediaList', async () => {
    const { bus, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const rpcCache = new Map<string, any>([
      [
        'rpc:MediaListCollection:ANIME:505:{}',
        {
          time: Date.now(),
          msg: {
            result: {
              entities: {
                user: { '505': { id: 505, name: 'NormalizrUser' } },
                media: {
                  '4242': { id: 4242, idMal: 888, format: 'TV', title: { userPreferred: 'Expanded Title' } }
                },
                listEntry: {
                  '9001': { id: 9001, media: 4242, status: 'CURRENT', score: 9, progress: 5 }
                },
                listSection: {
                  '0': { name: 'Watching', isCustomList: false, status: 'CURRENT', entries: [9001] }
                }
              }
            }
          }
        }
      ]
    ]);

    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => rpcCache,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: () => {},
      clearAuth: () => {}
    });

    const result = await anilist.AniList.getMediaList(505, 'ANIME');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.allEntries).toHaveLength(1);
    expect(result.lists).toHaveLength(1);
    expect(result.lists[0].entries).toHaveLength(1);
    expect(result.lists[0].entries[0]).toBe(result.allEntries[0]);
    expect(result.lists[0].entries[0].mediaId).toBe(4242);
    expect(result.lists[0].entries[0].media).toEqual({
      id: 4242,
      idMal: 888,
      format: 'TV',
      title: { userPreferred: 'Expanded Title' }
    });
  });

  it('BUG-22: preserves all-digit options.userName and rejects empty/0/NaN/negative targets before fetching', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    fetchMock.mockResolvedValueOnce(
      jsonRes({ data: { MediaListCollection: makeMlcPayload(888, '12345', 404) } })
    );

    const digitUserRes = await anilist.AniList.getMediaList('12345', 'ANIME', { userName: '12345' });
    expect(digitUserRes.allEntries[0].mediaId).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables).toEqual({ userId: undefined, userName: '12345', type: 'ANIME' });

    for (const badTarget of [0, '0', Number.NaN, -5, 1.5, '', '   '] as const) {
      await expect(anilist.AniList.getMediaList(badTarget, 'ANIME')).rejects.toThrow(
        /Invalid AniList user target/
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('BUG-23: ignores non-numeric __NUXT__ user ids in peek(), syncFromPage(), and hasAuth() without returning NaN or wiping valid sessions', async () => {
    const { bus, helpers, anilist } = await loadFreshAniList();
    const clearSpy = vi.fn();
    const clearAuthSpy = vi.fn();

    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => undefined,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: clearSpy,
      clearAuth: clearAuthSpy
    });

    (window as any).__NUXT__ = { state: { auth: { user: { id: 'abc', name: 'alice' } } } };

    expect(anilist.AniList.hasAuth()).toBe(false);
    expect(anilist.AniList.session.peek()).toEqual({ userId: null, username: null, scoreFormat: null });
    expect(Number.isNaN(anilist.AniList.session.userId as any)).toBe(false);

    helpers.store.set('al_user_id', 100);
    helpers.store.set('al_username', 'alice');
    helpers.store.set('al_score_format', 'POINT_10');

    expect(anilist.AniList.session.peek({ reconcile: true })).toEqual({
      userId: 100,
      username: 'alice',
      scoreFormat: 'POINT_10'
    });
    anilist.AniList.session.syncFromPage?.();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(clearAuthSpy).not.toHaveBeenCalled();
    expect(helpers.store.get('al_user_id', null)).toBe(100);

    (window as any).__NUXT__ = { state: { auth: { user: { id: 'abc', name: 'bob' } } } };
    anilist.AniList.session.syncFromPage?.();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(helpers.store.get('al_user_id', null)).toBeNull();
  });

  it('BUG-24: clears FastLoad cache bridge both before and after GraphQL mutations settle', async () => {
    const { bus, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const clearSpy = vi.fn();
    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => undefined,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: clearSpy,
      clearAuth: () => {}
    });

    let resolveMutation!: (res: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveMutation = resolve;
        })
    );

    const mutPromise = anilist.AniList.query('mutation { SaveMediaListEntry(mediaId: 1, progress: 2) { id } }');
    expect(clearSpy).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveMutation(jsonRes({ data: { SaveMediaListEntry: { id: 99 } } }));
    expect(await mutPromise).toEqual({ SaveMediaListEntry: { id: 99 } });
    expect(clearSpy).toHaveBeenCalledTimes(2);
  });
});

describe('AniList API — IMP-05: Waiter-isolated AbortSignal propagation & cancellation', () => {
  it('isolates AbortSignal across shared inflight exact & entity waiters and aborts fetch only when zero waiters remain', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    // Pre-aborted signal rejects without fetching
    const preAc = new AbortController();
    preAc.abort();
    await expect(
      anilist.AniList.query('query { Viewer { id } }', {}, { signal: preAc.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();

    // Shared exact + superset/subset entity waiters: aborting A leaves B alive
    let resolveFirst!: (res: Response) => void;
    let firstInitSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      firstInitSignal = init.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    });

    const acA = new AbortController();
    const acB = new AbortController();
    const supersetQ = 'query ($id: Int) { Media(id: $id) { id title { romaji english } episodes status } }';
    const subsetQ = 'query ($id: Int) { Media(id: $id) { id title { romaji } } }';

    const pA = anilist.AniList.query(supersetQ, { id: 501 }, { signal: acA.signal });
    const pB = anilist.AniList.query(subsetQ, { id: 501 }, { signal: acB.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(firstInitSignal?.aborted).toBe(false);

    acA.abort();
    await expect(pA).rejects.toMatchObject({ name: 'AbortError' });
    expect(firstInitSignal?.aborted).toBe(false);

    resolveFirst(
      jsonRes({
        data: { Media: { id: 501, title: { romaji: 'Alive', english: 'Alive' }, episodes: 12, status: 'FINISHED' } }
      })
    );
    const resB = await pB;
    expect(resB.Media.title.romaji).toBe('Alive');

    // When all waiters abort, shared fetch signal aborts and inflight entry is evicted cleanly
    let secondInitSignal: AbortSignal | undefined;
    fetchMock
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        secondInitSignal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      })
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 502, title: { romaji: 'Recovered' } } } }));

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = anilist.AniList.query(subsetQ, { id: 502 }, { signal: ac1.signal });
    const p2 = anilist.AniList.query(subsetQ, { id: 502 }, { signal: ac2.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    ac1.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    expect(secondInitSignal?.aborted).toBe(false);

    ac2.abort();
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(secondInitSignal?.aborted).toBe(true);

    const recovered = await anilist.AniList.query(subsetQ, { id: 502 });
    expect(recovered.Media.title.romaji).toBe('Recovered');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('aborts retry backoff sleep immediately without waiting for remaining delay', async () => {
    vi.useFakeTimers();
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('transient'));
    window.fetch = fetchMock as any;

    const ac = new AbortController();
    const pending = anilist.AniList.query('query { Media(id: 600) { id } }', {}, { retries: 3, signal: ac.signal });
    const handled = pending.catch((e) => e);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    ac.abort();
    const err = await handled;
    expect(err?.name).toBe('AbortError');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates AbortSignal through getMediaList and viewer', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    window.fetch = fetchMock as any;
    (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'Alice' } } } };

    const acList = new AbortController();
    const listPromise = anilist.AniList.getMediaList(100, 'ANIME', { signal: acList.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    acList.abort();
    await expect(listPromise).rejects.toMatchObject({ name: 'AbortError' });

    const acViewer = new AbortController();
    const viewerPromise = anilist.AniList.viewer(true, { signal: acViewer.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    acViewer.abort();
    await expect(viewerPromise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('AniList API — Cycle 2: BUG-13, BUG-14, BUG-15', () => {
  it('BUG-13: bypasses incomplete entityCache MediaListCollection records from partial query() calls in getMediaList()', async () => {
    const { anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    fetchMock
      .mockResolvedValueOnce(
        jsonRes({
          data: {
            MediaListCollection: {
              lists: [{ entries: [{ id: 101 }] }]
            }
          }
        })
      )
      .mockResolvedValueOnce(
        jsonRes({
          data: {
            MediaListCollection: {
              user: { id: 500, name: 'Alice' },
              lists: [
                {
                  name: 'Completed',
                  status: 'COMPLETED',
                  entries: [{ id: 102, mediaId: 202, status: 'COMPLETED', score: 8, progress: 12 }]
                }
              ]
            }
          }
        })
      )
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(500, 'Alice', 303) } }));

    // Minimal partial query caches MediaListCollection:ANIME:500 with incomplete fields
    await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { lists { entries { id } } } }',
      { userId: 500, type: 'ANIME' }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Partial query with >12 fields (isSuperset heuristic true) but still missing required fields like completedAt/media.title.native
    await anilist.AniList.query(
      'query ($userId: Int, $type: MediaType) { MediaListCollection(userId: $userId, type: $type) { user { id name } lists { name status entries { id mediaId status score progress repeat priority notes media { id format } } } } }',
      { userId: 500, type: 'ANIME' }
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // getMediaList() must bypass the incomplete entityCache record and fetch the full list
    const full = await anilist.AniList.getMediaList(500, 'ANIME');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(full.allEntries[0].mediaId).toBe(303);
    expect(full.allEntries[0].media?.title?.userPreferred).toBe('Media 303');

    // Subsequent getMediaList() now hits entityCache with complete fields
    const cached = await anilist.AniList.getMediaList(500, 'ANIME');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cached.allEntries[0].mediaId).toBe(303);
  });

  it('BUG-14: awaits identical shared rpcInflight flight at most once and falls back to /graphql on upstream AbortError', async () => {
    vi.useFakeTimers();
    const { bus, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const userMap = new Map<string, number>([['alice', 500]]);
    const idMap = new Map<number, string>([[500, 'alice']]);
    const sharedStalledFlight = { promise: new Promise<any>(() => {}) };
    const rpcInflight = new Map<string, { promise: Promise<any> }>([
      ['rpc:MediaListCollection:ANIME:500:{}', sharedStalledFlight],
      ['rpc:MediaListCollection:ANIME:alice:{}', sharedStalledFlight],
      ['rpc:MediaListCollection:ANIME:Alice:{}', sharedStalledFlight]
    ]);

    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => undefined,
      getRpcInflight: () => rpcInflight,
      getUserMap: () => userMap,
      getIdMap: () => idMap,
      clear: () => {},
      clearAuth: () => {}
    });

    fetchMock.mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(500, 'alice', 404) } }));

    const listPromise = anilist.AniList.getMediaList(500, 'ANIME');
    // Only a single 5000 ms timeout should be scheduled across all 3 matching keys sharing one flight
    await vi.advanceTimersByTimeAsync(5000);
    const res = await listPromise;
    expect(res.allEntries[0].mediaId).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const inflightTimeouts = setTimeoutSpy.mock.calls.filter((c) => c[1] === 5000);
    expect(inflightTimeouts).toHaveLength(1);

    // Upstream FastLoad AbortError must fall back cleanly to /graphql when caller signal is not aborted
    rpcInflight.clear();
    const upstreamAbortFlight = {
      promise: Promise.reject(new DOMException('FastLoad yielded', 'AbortError'))
    };
    rpcInflight.set('rpc:MediaListCollection:ANIME:501:{}', upstreamAbortFlight);
    fetchMock.mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(501, 'bob', 505) } }));

    const callerAc = new AbortController();
    const fallbackRes = await anilist.AniList.getMediaList(501, 'ANIME', { signal: callerAc.signal });
    expect(fallbackRes.allEntries[0].mediaId).toBe(505);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Caller's own AbortSignal still aborts getMediaList immediately without calling /graphql
    rpcInflight.clear();
    rpcInflight.set('rpc:MediaListCollection:ANIME:502:{}', { promise: new Promise<any>(() => {}) });
    const abortAc = new AbortController();
    const abortedPromise = anilist.AniList.getMediaList(502, 'ANIME', { signal: abortAc.signal });
    const handledAbort = abortedPromise.catch((err) => err);
    abortAc.abort();
    const err = await handledAbort;
    expect(err?.name).toBe('AbortError');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('BUG-15: clamps negative clock-skew resetDelay to 0 so HTTP 429 without Retry-After applies 60000 ms cooldown', async () => {
    vi.useFakeTimers();
    const now = 1_700_000_005_000;
    vi.setSystemTime(now);

    const { anilist } = await loadFreshAniList();
    const limiterMod = await import('../src/utils/limiter');
    const limitSpy = vi.spyOn(limiterMod.RateLimiter.prototype, 'limit');

    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ message: 'Too Many Requests' }] }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Reset': String(Math.floor((now - 5000) / 1000))
          }
        })
      )
      .mockResolvedValueOnce(jsonRes({ data: { Media: { id: 88 } } }));

    const res = await anilist.AniList.query('query { Media(id: 88) { id } }', {}, { retries: 1 });
    expect(res).toEqual({ Media: { id: 88 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(limitSpy).toHaveBeenCalledWith(60000);
    expect(anilist.AniList.resumeAt()).toBe(now + 60000);
  });

  it('BUG-25: rejects minimal or incomplete FastLoad MediaListCollection cache entries and falls back to /graphql', async () => {
    const { bus, anilist } = await loadFreshAniList();
    const fetchMock = vi.fn();
    window.fetch = fetchMock as any;

    const gqlStore = new Map<string, any>([
      // Minimal { lists { name } } payload lacking entries array
      [
        'gql:MediaListCollection:ANIME:500:{}',
        encodeGqlSnap({ data: { MediaListCollection: { lists: [{ name: 'Watching' }] } } })
      ],
      // Partial entry payload missing media & status
      [
        'gql:MediaListCollection:ANIME:502:{}',
        encodeGqlSnap({
          data: { MediaListCollection: { lists: [{ name: 'Watching', entries: [{ id: 1, mediaId: 42 }] }] } }
        })
      ]
    ]);
    const rpcCache = new Map<string, any>([
      [
        'rpc:MediaListCollection:ANIME:501:{}',
        {
          time: Date.now(),
          msg: { result: { MediaListCollection: { lists: [{ name: 'Watching', entries: [{ id: 2, mediaId: 99 }] }] } } }
        }
      ]
    ]);

    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => gqlStore,
      getRpcCache: () => rpcCache,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: () => {},
      clearAuth: () => {}
    });

    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(500, 'Alice', 701) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(502, 'Bob', 702) } }))
      .mockResolvedValueOnce(jsonRes({ data: { MediaListCollection: makeMlcPayload(501, 'Carol', 703) } }));

    const r500 = await anilist.AniList.getMediaList(500, 'ANIME');
    expect(r500.allEntries[0].mediaId).toBe(701);

    const r502 = await anilist.AniList.getMediaList(502, 'ANIME');
    expect(r502.allEntries[0].mediaId).toBe(702);

    const r501 = await anilist.AniList.getMediaList(501, 'ANIME');
    expect(r501.allEntries[0].mediaId).toBe(703);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});