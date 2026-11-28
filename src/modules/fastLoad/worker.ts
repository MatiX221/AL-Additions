import type { CleanupFn } from '../../types';
import {
  win,
  coreHooks,
  coreSession,
  coreStorage,
  fastLoadRpcLog,
  rpcCache,
  rpcInflight,
  rpcEpoch,
  freshFloor,
  userMap,
  idToUserMap,
  rememberUser,
  clearGlobalCache,
  lastAuth,
  setLastAuth,
  clearLastAuth,
  onRpcClear
} from './state';
import { stats, attempt } from './config';
import {
  isMediaListQuery,
  isTaxonomyQuery,
  isUnfilteredMediaListQuery,
  resolveMediaListQuery,
  isUserQuery,
  isViewerQuery,
  isMutation,
  isVolatile,
  buildQueryCacheKey,
  isRpcBlocked
} from './helpers';

export { lastAuth, clearLastAuth };

export const workerPending = new WeakMap<
  object,
  Map<
    string,
    {
      key: string | null;
      mutation: boolean;
      epoch?: number;
      extraKeys?: string[];
      url?: string;
      query?: string;
      variables?: Record<string, any>;
      operationName?: string;
    }
  >
>();
export const watched = new WeakSet<object>();
export let workerUrl: string | null = null;
export let workerOpts: any;
export let WorkerCtor: any = null;

let workerDisposed = false;
let activeYielded: (() => boolean) | null = null;
const activePrefetchCleanups = new Set<() => void>();

const isWorkerInactive = (yielded?: () => boolean): boolean =>
  workerDisposed || Boolean(yielded?.()) || Boolean(activeYielded?.());

const RPC_MAX_ENTRIES = 32;
const PREFETCH_COOLDOWN_MS = 60_000;
const PREFETCH_KEYS_MAX = 200;

const clone = (v: any) => {
  try {
    return (win.structuredClone || structuredClone)(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
};

export const findWorkerUrl = (): string | null =>
  workerUrl ||
  (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .map((e) => e.name)
    .find((n) => /\.worker\.js(?:\?|$)/.test(n)) ||
  attempt(() => coreStorage?.get<string | null>('workerUrl', null)) ||
  null;

export const isRpcFetch = (d: any) =>
  !!d && d.type === 'RPC' && d.method === 'fetch' && Array.isArray(d.params) && typeof d.params[1] === 'string';

export const rpcKey = (params: any[]) => {
  const [endpoint, query, variables, headers] = params;
  const auth = String(headers?.Authorization ?? headers?.authorization ?? '');
  return buildQueryCacheKey('rpc', endpoint, query, variables, auth);
};

function hasMediaListNextChunk(res: any): boolean {
  if (!res || typeof res !== 'object') return false;
  return (
    res.hasNextChunk === true ||
    res.MediaListCollection?.hasNextChunk === true ||
    res.data?.MediaListCollection?.hasNextChunk === true
  );
}

export function extractUsersFromRpcResult(res: any) {
  if (!res || typeof res !== 'object') return;
  attempt(() => {
    const scanUsers = (obj: any, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 5) return;
      if (
        typeof obj.name === 'string' &&
        obj.avatar &&
        obj.id &&
        (typeof obj.id === 'number' || /^\d+$/.test(String(obj.id)))
      ) {
        rememberUser(String(obj.name), Number(obj.id));
      }
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') scanUsers(v, depth + 1);
      }
    };
    scanUsers(res);

    const viewer = res.Viewer || res.data?.Viewer;
    if (viewer && (viewer.id || viewer.name)) {
      if (viewer.id && viewer.name) {
        rememberUser(String(viewer.name), Number(viewer.id));
      }
      coreSession?.recordHint({
        userId: viewer.id ? Number(viewer.id) : undefined,
        username: viewer.name ? String(viewer.name) : undefined
      });
    }
    const user = res.User || res.data?.User || res.MediaListCollection?.user || res.data?.MediaListCollection?.user;
    if (user && user.id && user.name) {
      rememberUser(String(user.name), Number(user.id));
    }
  });
}

export const onIn = function (this: any, ev: MessageEvent) {
  if (isWorkerInactive()) return;
  const d: any = ev.data;
  if (!d || d.type !== 'RPC') return;
  const id = String(d.id);
  const worker = (ev.currentTarget || ev.target || this) as any;
  const pMap = workerPending.get(worker);
  if (!pMap) return;
  const p = pMap.get(id);
  if (!p) return;
  pMap.delete(id);
  fastLoadRpcLog?.debug('IN', id, Object.keys(d));
  if (d.result) {
    extractUsersFromRpcResult(d.result);
  }
  if (p.mutation) {
    if (coreHooks?.hasGqlFetchSubscribers() && p.query) {
      coreHooks.emitGqlFetch({
        phase: 'response',
        url: p.url || '/graphql',
        query: p.query,
        variables: p.variables || {},
        operationName: p.operationName,
        status: d.error == null ? 200 : 500,
        ok: d.error == null,
        data: d.result?.data ?? d.result,
        errors:
          d.error != null
            ? [{ message: String(d.error) }]
            : Array.isArray(d.result?.errors)
            ? d.result.errors
            : undefined
      });
    }
    return clearGlobalCache();
  }
  if (p.key && d.error == null && p.epoch === rpcEpoch) {
    attempt(() => {
      const hasNextChunk = hasMediaListNextChunk(d.result);
      const unfilteredMlcMatch = p.key?.match(/^rpc:MediaListCollection:([A-Z]+):([^:]+):\{\}$/i);
      if (unfilteredMlcMatch && hasNextChunk) {
        return;
      }

      const cached = { time: Date.now(), msg: clone(d) };
      let moreKeys: string[] = [];
      const mlcUser = d.result?.MediaListCollection?.user || d.result?.data?.MediaListCollection?.user;
      const uid = mlcUser?.id ? Number(mlcUser.id) : undefined;
      const uname = mlcUser?.name ? String(mlcUser.name) : undefined;
      if (uid && uname) {
        rememberUser(uname, uid);
      }
      if (unfilteredMlcMatch && !hasNextChunk) {
        const type = unfilteredMlcMatch[1];
        const target = unfilteredMlcMatch[2];
        const isNumeric = /^\d+$/.test(target);
        const resolvedUserId = isNumeric ? Number(target) : uid || userMap.get(target.toLowerCase());
        const resolvedUserName = !isNumeric ? target : uname || (resolvedUserId ? idToUserMap.get(resolvedUserId) : undefined);
        moreKeys = getMediaListKeys(type, resolvedUserId, resolvedUserName);
      }
      const keysToSet = [...new Set([p.key!, ...(p.extraKeys || []), ...moreKeys])];
      for (const k of keysToSet) {
        rpcCache.delete(k);
        rpcCache.set(k, cached);
      }
      while (rpcCache.size > RPC_MAX_ENTRIES) rpcCache.delete(rpcCache.keys().next().value as string);
    });
  }
};

export const getMediaListKeys = (type: string, userId?: number, userName?: string): string[] => {
  const keys = new Set<string>();
  const t = String(type).toUpperCase();
  if (userId) {
    keys.add(`rpc:MediaListCollection:${t}:${userId}:{}`);
    const mappedName = idToUserMap.get(userId);
    if (mappedName) keys.add(`rpc:MediaListCollection:${t}:${mappedName}:{}`);
  }
  if (userName) {
    const norm = String(userName).trim().toLowerCase();
    keys.add(`rpc:MediaListCollection:${t}:${norm}:{}`);
    const mappedId = userMap.get(norm);
    if (mappedId) keys.add(`rpc:MediaListCollection:${t}:${mappedId}:{}`);
  }
  return [...keys];
};

const prefetchedWorkerKeys = new Map<string, number>();
onRpcClear(() => prefetchedWorkerKeys.clear());

function recordPrefetchedWorkerKeys(keys: string[], now: number): void {
  if (prefetchedWorkerKeys.size >= PREFETCH_KEYS_MAX) {
    for (const [k, t] of prefetchedWorkerKeys) {
      if (now - t >= PREFETCH_COOLDOWN_MS) prefetchedWorkerKeys.delete(k);
    }
    while (prefetchedWorkerKeys.size >= PREFETCH_KEYS_MAX) {
      const oldest = prefetchedWorkerKeys.keys().next().value;
      if (oldest === undefined) break;
      prefetchedWorkerKeys.delete(oldest);
    }
  }
  for (const k of keys) {
    prefetchedWorkerKeys.delete(k);
    prefetchedWorkerKeys.set(k, now);
  }
  while (prefetchedWorkerKeys.size > PREFETCH_KEYS_MAX) {
    const oldest = prefetchedWorkerKeys.keys().next().value;
    if (oldest === undefined) break;
    prefetchedWorkerKeys.delete(oldest);
  }
}

export function prefetchWorkerList(
  type: 'ANIME' | 'MANGA',
  userId: number,
  userName?: string,
  yielded?: () => boolean
) {
  if (isWorkerInactive(yielded) || coreHooks?.isPrefetchSuppressed()) return;
  const url = findWorkerUrl();
  if (!url || !WorkerCtor) {
    fastLoadRpcLog?.debug('Prefetch skipped: worker script unknown');
    return;
  }
  if (!userId && userName) {
    userId = userMap.get(userName.toLowerCase()) || 0;
  }
  if (userId && !userName) {
    userName = idToUserMap.get(userId) || undefined;
  }

  const raw = attempt(() => coreStorage?.get<any>('rpc:listTpl:v2', null));
  let tpl: any;
  if (raw) {
    try {
      tpl = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {}
  }
  if (!tpl || typeof tpl.query !== 'string' || !isUnfilteredMediaListQuery({ query: tpl.query, variables: tpl.vars })) {
    fastLoadRpcLog?.debug('Prefetch skipped: no list template yet');
    return;
  }

  const vars: any = { ...(tpl.vars || {}), type };
  if (userId) {
    vars.userId = userId;
    delete vars.userName;
  } else if (userName) {
    vars.userName = userName;
    delete vars.userId;
  }
  const authVal = lastAuth || coreHooks?.getAuthHeader() || '';
  const headers: any = { ...(tpl.headers || {}) };
  if (authVal) {
    headers.Authorization = authVal;
    headers.authorization = authVal;
  }
  const options = tpl.options
    ? { ...tpl.options, ...(tpl.options.schemaArgs ? { schemaArgs: [type] } : {}) }
    : tpl.options;
  const params = [tpl.endpoint, tpl.query, vars, headers, options];
  const key = rpcKey(params);
  const now = Date.now();

  const possibleKeys = getMediaListKeys(type, userId, userName);
  if (rpcInflight.has(key)) return;
  for (const k of possibleKeys) {
    const hit = rpcCache.get(k);
    if (hit && hit.time >= freshFloor && now - hit.time < 5 * 60_000) return;
    if (rpcInflight.has(k)) return;
  }
  if (now - (prefetchedWorkerKeys.get(key) || 0) < PREFETCH_COOLDOWN_MS) return;
  recordPrefetchedWorkerKeys([key, ...possibleKeys], now);

  let w: Worker;
  try {
    w = new WorkerCtor(url, workerOpts);
  } catch (err) {
    fastLoadRpcLog?.debug('Prefetch worker failed to start', err);
    return;
  }
  const id = `alfl_prefetch_${type}_${now}`;

  let resolver!: (val: any) => void;
  let rejecter!: (err: any) => void;
  const flightPromise = new Promise((resolve, reject) => {
    resolver = resolve;
    rejecter = reject;
  });
  flightPromise.catch(() => {});
  const flight = { promise: flightPromise, resolve: resolver, reject: rejecter };
  const allFlightKeys = [...new Set([key, ...possibleKeys])];
  rpcInflight.set(key, flight);
  for (const k of possibleKeys) {
    if (!rpcInflight.has(k)) rpcInflight.set(k, flight);
  }

  const clearOwnInflight = () => {
    for (const k of allFlightKeys) {
      if (rpcInflight.get(k) === flight) {
        rpcInflight.delete(k);
      }
    }
  };

  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (reason = 'finished') => {
    if (finished) return;
    finished = true;
    activePrefetchCleanups.delete(finish);
    if (timer !== undefined) clearTimeout(timer);
    clearOwnInflight();
    flight.reject(new Error(reason));
    attempt(() => w.terminate());
  };
  timer = setTimeout(() => {
    fastLoadRpcLog?.debug('Prefetch timed out', type);
    finish('finished');
  }, 30_000);
  activePrefetchCleanups.add(finish);

  const startEpoch = rpcEpoch;
  w.addEventListener('message', (ev: MessageEvent) => {
    const d: any = ev.data;
    if (!d || d.type !== 'RPC' || String(d.id) !== id) return;
    if (startEpoch !== rpcEpoch || isWorkerInactive(yielded)) {
      finish('stale');
      return;
    }
    if (finished) return;
    finished = true;
    activePrefetchCleanups.delete(finish);
    if (timer !== undefined) clearTimeout(timer);
    if (d.error == null) {
      if (!hasMediaListNextChunk(d.result)) {
        attempt(() => {
          extractUsersFromRpcResult(d.result);
          const mlcUser = d.result?.MediaListCollection?.user || d.result?.data?.MediaListCollection?.user;
          const extractedUserId = mlcUser?.id ? Number(mlcUser.id) : 0;
          const resolvedUserId = userId || extractedUserId || (userName ? userMap.get(userName.toLowerCase()) : 0) || 0;
          if (userName && resolvedUserId) {
            rememberUser(userName, resolvedUserId);
          }
          const resolvedUserName = userName || (resolvedUserId ? idToUserMap.get(resolvedUserId) : undefined);
          const cached = { time: Date.now(), msg: clone(d) };
          const allKeys = [
            ...new Set([
              key,
              ...possibleKeys,
              ...getMediaListKeys(type, resolvedUserId, resolvedUserName)
            ])
          ];
          for (const k of allKeys) {
            rpcCache.delete(k);
            rpcCache.set(k, cached);
          }
          while (rpcCache.size > RPC_MAX_ENTRIES) rpcCache.delete(rpcCache.keys().next().value as string);
        });
        fastLoadRpcLog?.debug('Prefetch cached', type, Object.keys(d));
      }
      clearOwnInflight();
      flight.resolve(d);
    } else {
      fastLoadRpcLog?.debug('Prefetch failed', d.error);
      clearOwnInflight();
      flight.reject(d.error);
    }
    attempt(() => w.terminate());
  });

  w.addEventListener('error', (e: any) => {
    fastLoadRpcLog?.debug('Prefetch worker error', e?.message);
    if (!isWorkerInactive(yielded) && startEpoch === rpcEpoch) {
      attempt(() => {
        coreStorage?.del('workerUrl');
      });
      workerUrl = null;
    }
    finish('error');
  });

  fastLoadRpcLog?.debug('Prefetch dispatching', type, vars);
  try {
    w.postMessage({ type: 'RPC', id, method: 'fetch', params });
  } catch {
    finish('post-error');
  }
}

export function hookWorker(yielded: () => boolean): CleanupFn {
  workerDisposed = false;
  activeYielded = yielded;
  let hookDisposed = false;
  const isInactive = () => hookDisposed || workerDisposed || yielded();

  let pageWin: any = null;
  let origCtor: any = null;
  let ProxiedWorker: any = null;
  let hookedProto: any = null;
  let origPost: any = null;
  let wrappedPost: any = null;

  attempt(() => {
    pageWin = win;
    origCtor = pageWin.Worker;
    WorkerCtor = origCtor;
    if (origCtor && !(origCtor as any).__alfl_ctor_hooked) {
      try {
        ProxiedWorker = function (this: any, scriptURL: string | URL, options?: WorkerOptions) {
          const instance = Reflect.construct(origCtor, [scriptURL, options], new.target || ProxiedWorker);
          if (!isInactive()) {
            const urlStr = String(scriptURL || '');
            if (urlStr.includes('worker.js') && !urlStr.includes('cloudflare')) {
              attempt(() => {
                workerUrl = new URL(urlStr, win.location.href).href;
                coreStorage?.set('workerUrl', workerUrl);
              });
              workerOpts = options;
              fastLoadRpcLog?.debug('Page worker created:', urlStr);
            }
            if (!watched.has(instance)) {
              watched.add(instance);
              instance.addEventListener('message', onIn);
            }
          }
          return instance;
        } as any;
        ProxiedWorker.prototype = origCtor.prototype;
        ProxiedWorker.__alfl_ctor_hooked = true;
        pageWin.Worker = ProxiedWorker;
      } catch {
        ProxiedWorker = null;
      }
    }

    const W = pageWin.Worker;
    if (!W?.prototype || (W.prototype as any).__alfl_hooked) return;
    hookedProto = W.prototype;
    (hookedProto as any).__alfl_hooked = true;
    origPost = hookedProto.postMessage;
    wrappedPost = function (this: Worker, data: any, ...rest: any[]) {
      try {
        if (!isInactive() && isRpcFetch(data)) {
          const id = String(data.id || '');
          if (id.startsWith('alfl_prefetch_')) {
            return origPost.apply(this, [data, ...rest] as any);
          }
          if (isRpcBlocked(String(data.params[1]), data.params[2])) {
            fastLoadRpcLog?.debug('Blocked request:', JSON.stringify(data.params[2]).slice(0, 60));
            const targetId = data.params[2]?.id || data.params[2]?.userId;
            const pageId = data.params[4]?.page?.id || (targetId ? `listComparison-${targetId}` : 'listComparison');
            const pageNum = data.params[2]?.page || 1;
            const dummyResult = {
              entities: {
                page: {
                  [pageId]: {
                    pageInfo: {
                      total: 0,
                      perPage: 30,
                      currentPage: pageNum,
                      lastPage: 1,
                      hasNextPage: false
                    },
                    pageData: []
                  }
                }
              },
              result: pageId,
              data: {
                Page: {
                  pageInfo: { total: 0, perPage: 30, currentPage: pageNum, lastPage: 1, hasNextPage: false },
                  mediaList: []
                }
              }
            };
            setTimeout(() => {
              if (isInactive()) return;
              try {
                this.dispatchEvent(
                  new MessageEvent('message', {
                    data: { type: 'RPC', id: data.id, result: dummyResult }
                  })
                );
              } catch {
                const ev: any = (win.document || document).createEvent('Event');
                ev.initEvent('message', false, false);
                ev.data = { type: 'RPC', id: data.id, result: dummyResult };
                this.dispatchEvent(ev);
              }
            }, 0);
            return;
          }
          if (!watched.has(this)) {
            watched.add(this);
            this.addEventListener('message', onIn);
          }
          const h = data.params[3] || {};
          const a = h.Authorization ?? h.authorization;
          if (a && /^Bearer\s+/i.test(String(a)) && !coreHooks?.isSessionClearing()) {
            setLastAuth(String(a));
            coreHooks?.setAuthHeader(lastAuth);
          }
          const q = { query: data.params[1], variables: data.params[2] };
          const mlcInfo = resolveMediaListQuery(q);
          const unfilteredMediaList = mlcInfo.canonical;
          if (unfilteredMediaList && !mlcInfo.hasInlineLiterals) {
            attempt(() => {
              const headers = { ...h };
              delete headers.Authorization;
              delete headers.authorization;
              const tplStr = JSON.stringify({
                endpoint: data.params[0],
                query: data.params[1],
                vars: data.params[2],
                headers,
                options: data.params[4]
              });
              coreStorage?.set('rpc:listTpl:v2', tplStr);
            });
          }
          if (isMutation(q)) {
            clearGlobalCache();
            const queryStr = String(q.query || '');
            const varsObj = q.variables && typeof q.variables === 'object' ? q.variables : {};
            const opMatch = queryStr.match(/^\s*(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/);
            const operationName = opMatch ? opMatch[1] : undefined;
            const url = String(data.params[0] || '/graphql');
            if (coreHooks?.hasGqlFetchSubscribers() && queryStr) {
              coreHooks.emitGqlFetch({
                phase: 'request',
                url,
                query: queryStr,
                variables: varsObj,
                operationName
              });
            }
            let pMap = workerPending.get(this);
            if (!pMap) {
              pMap = new Map();
              workerPending.set(this, pMap);
            }
            pMap.set(id, { key: null, mutation: true, url, query: queryStr, variables: varsObj, operationName });
          } else if (!isVolatile(q)) {
            const key = rpcKey(data.params);
            const label = String(q.query).replace(/\s+/g, ' ').slice(0, 50);
            let hit: any = null;
            let flying: any = null;
            let extraKeys: string[] | undefined;

            if (unfilteredMediaList) {
              let { type = 'ANIME', userId, userName } = mlcInfo.vars;

              if (!userName && userId) {
                userName = idToUserMap.get(userId);
              }
              if (!userId && userName) {
                userId = userMap.get(userName.toLowerCase());
              }

              extraKeys = [...new Set([key, ...getMediaListKeys(type || 'ANIME', userId, userName)])];
              for (const k of extraKeys) {
                if (!hit) {
                  const h = rpcCache.get(k);
                  if (h && h.time >= freshFloor && Date.now() - h.time < 5 * 60_000) {
                    hit = h;
                  }
                }
                if (!flying) {
                  const f = rpcInflight.get(k);
                  if (f) flying = f;
                }
              }
            } else {
              const rpcTtl =
                isMediaListQuery(q) || isViewerQuery(q) || isTaxonomyQuery(q)
                  ? 5 * 60_000
                  : isUserQuery(q)
                  ? 60_000
                  : 15_000;
              const h = rpcCache.get(key);
              if (h && h.time >= freshFloor && Date.now() - h.time < rpcTtl) {
                hit = h;
              }
              flying = rpcInflight.get(key);
            }

            if (hit) {
              stats.cacheHits++;
              fastLoadRpcLog?.debug('HIT', label, `${Math.round((Date.now() - hit.time) / 1000)}s old`);
              const worker = this;
              const reply = { ...clone(hit.msg), id: data.id };
              const MessageEventCtor = win.MessageEvent || MessageEvent;
              let dispatched = false;
              setTimeout(() => {
                if (dispatched) return;
                dispatched = true;
                if (isInactive()) {
                  origPost.apply(worker, [data, ...rest] as any);
                  return;
                }
                worker.dispatchEvent(new MessageEventCtor('message', { data: reply }));
              }, 0);
              return;
            }

            if (flying) {
              stats.deduped++;
              fastLoadRpcLog?.debug('Attached to in-flight prefetch:', label);
              const worker = this;
              const replyId = data.id;
              let dispatched = false;
              const forwardOriginal = () => {
                if (dispatched) return;
                dispatched = true;
                origPost.apply(worker, [data, ...rest] as any);
              };
              flying.promise.then(
                (msg: any) => {
                  if (dispatched) return;
                  if (isInactive()) {
                    forwardOriginal();
                    return;
                  }
                  fastLoadRpcLog?.debug('In-flight prefetch delivered to page:', label);
                  const reply = { ...clone(msg), id: replyId };
                  const MessageEventCtor = win.MessageEvent || MessageEvent;
                  setTimeout(() => {
                    if (dispatched) return;
                    if (isInactive()) {
                      forwardOriginal();
                      return;
                    }
                    dispatched = true;
                    worker.dispatchEvent(new MessageEventCtor('message', { data: reply }));
                  }, 0);
                },
                () => {
                  forwardOriginal();
                }
              );
              return;
            }

            fastLoadRpcLog?.debug('MISS', label, JSON.stringify(q.variables).slice(0, 80));
            let pMap = workerPending.get(this);
            if (!pMap) {
              pMap = new Map();
              workerPending.set(this, pMap);
            }
            pMap.set(id, { key, mutation: false, epoch: rpcEpoch, extraKeys });
          }
        }
      } catch {
        /* fall through to the real worker */
      }
      return origPost.apply(this, [data, ...rest] as any);
    };
    hookedProto.postMessage = wrappedPost;
  });

  return () => {
    hookDisposed = true;
    workerDisposed = true;
    for (const cleanup of [...activePrefetchCleanups]) {
      attempt(cleanup);
    }
    activePrefetchCleanups.clear();
    prefetchedWorkerKeys.clear();
    if (activeYielded === yielded) activeYielded = null;
    if (ProxiedWorker) {
      if (pageWin && pageWin.Worker === ProxiedWorker) {
        pageWin.Worker = origCtor;
      }
      delete ProxiedWorker.__alfl_ctor_hooked;
    }
    if (hookedProto) {
      if (hookedProto.postMessage === wrappedPost) {
        hookedProto.postMessage = origPost;
      }
      if ((hookedProto as any).__alfl_hooked) {
        delete (hookedProto as any).__alfl_hooked;
      }
    }
    if (WorkerCtor === origCtor) {
      WorkerCtor = null;
    }
  };
}
