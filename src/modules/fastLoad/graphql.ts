import {
  win,
  coreHooks,
  coreStorage,
  fastLoadLog,
  store,
  inflight,
  bytes,
  epoch,
  pausedUntil,
  freshFloor,
  setBytes,
  setPausedUntil,
  clearGlobalCache
} from './state';
import { CFG, stats, attempt } from './config';
import {
  getTaxonomyKind,
  isMediaListQuery,
  isTaxonomyQuery,
  isViewerQuery,
  isMutation,
  isVolatile,
  noStore,
  normalizeVariables,
  hashGqlQuery,
  stableStringify,
  parseBody,
  buildQueryCacheKey,
  isRpcBlocked
} from './helpers';
import { extractUsersFromRpcResult } from './worker';
import { rememberQuery } from './routes';

export const isGraphQL = (u: any): boolean => {
  try {
    const raw = u && typeof u === 'object' && typeof u.href === 'string' ? u.href : u;
    const url = new URL(raw, win.location.href);
    return (
      url.origin === 'https://graphql.anilist.co' ||
      (url.origin === win.location.origin && url.pathname.replace(/\/$/, '') === '/graphql')
    );
  } catch {
    return false;
  }
};

const SKIP_HEADERS = /^(?:content-encoding|content-length|transfer-encoding)$/i;
const RATE_HEADERS = /^(?:retry-after|x-ratelimit-.+)$/i;

function toResponse(snap: any, live?: Response) {
  const HeadersCtor = win.Headers || Headers;
  const ResponseCtor = win.Response || Response;
  const headers = new HeadersCtor(snap.headers);
  if (live) {
    for (const [k, v] of (live.headers as any).entries()) {
      if (RATE_HEADERS.test(k)) headers.set(k, v);
    }
  }
  const status = snap.status || 200;
  const body = status === 204 || status === 304 ? null : snap.buf;
  return new ResponseCtor(body, { status, statusText: snap.statusText || 'OK', headers });
}

function abortable(promise: Promise<any>, signal?: AbortSignal | null) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject((signal as any).reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    if (signal.aborted) return fail();
    signal.addEventListener('abort', fail, { once: true });
    const done = () => signal.removeEventListener('abort', fail);
    promise.then(
      (v) => {
        done();
        resolve(v);
      },
      (e) => {
        done();
        reject(e);
      }
    );
  });
}

function evict() {
  const now = Date.now();
  let currentBytes = bytes;
  for (const [key, entry] of store) {
    if (now - entry.time <= CFG.gqlStaleTtl && currentBytes <= CFG.gqlMaxBytes) break;
    currentBytes -= entry.size;
    store.delete(key);
  }
  setBytes(currentBytes);
}

function put(key: string, snap: any) {
  const old = store.get(key);
  let currentBytes = bytes;
  if (old) {
    currentBytes -= old.size;
    store.delete(key);
  }
  const size = snap.buf.byteLength;
  if (size > CFG.gqlMaxEntryBytes) return;
  store.set(key, { time: Date.now(), size, snap });
  currentBytes += size;
  setBytes(currentBytes);
  evict();
}

const decoder = new TextDecoder();
function hasGraphQLErrors(buf: ArrayBuffer): boolean {
  try {
    const json = JSON.parse(decoder.decode(buf));
    if (!json || typeof json !== 'object') return true;
    return Array.isArray(json.errors) && json.errors.length > 0;
  } catch {
    return true;
  }
}

export function makeKey(d: any, parsed: any): string {
  const authHeader = String(d.headers?.get?.('authorization') || '');
  return buildQueryCacheKey('gql', d.url, parsed?.query || '', parsed?.variables, authHeader);
}

const TAXONOMY_TTL = 24 * 3600 * 1000;

function getTaxonomyStorageKey(parsed: any): string | null {
  const taxKind = getTaxonomyKind(parsed);
  if (!taxKind) return null;
  const normVars = stableStringify(normalizeVariables(parsed?.variables));
  if (normVars !== '{}') return null;
  return `taxonomy:v2:${taxKind}:${hashGqlQuery(parsed?.query || '')}`;
}

function getQueryTtl(parsed: any): number {
  if (isTaxonomyQuery(parsed)) return TAXONOMY_TTL;
  if (isMediaListQuery(parsed)) return 5 * 60_000;
  if (isViewerQuery(parsed)) return 5 * 60_000;
  return CFG.gqlTtl;
}

function loadStoredTaxonomy(storageKey: string): {
  time: number;
  text: string;
  status: number;
  statusText: string;
  headers: [string, string][];
} | null {
  try {
    const raw = coreStorage?.get<any>(storageKey, null);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed.time === 'number' && typeof parsed.text === 'string') return parsed;
  } catch {}
  return null;
}

function persistStoredTaxonomy(storageKey: string, snap: any) {
  attempt(() => {
    const text = decoder.decode(snap.buf);
    coreStorage?.set(storageKey, {
      time: Date.now(),
      text,
      status: snap.status,
      statusText: snap.statusText,
      headers: snap.headers
    });
  });
}

const note429 = (res: Response) => {
  if (res.status === 429) setPausedUntil(Date.now() + 60_000);
};

export async function classify(input: any, init?: RequestInit) {
  const isRequest =
    Boolean(input && typeof input === 'object') &&
    ((typeof win.Request === 'function' && input instanceof win.Request) ||
      (typeof Request === 'function' && input instanceof Request));
  const method = String(init?.method || (typeof input?.method === 'string' ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') return null;

  const rawUrl =
    typeof input === 'string'
      ? input
      : typeof input?.url === 'string'
      ? input.url
      : typeof input?.href === 'string'
      ? input.href
      : String(input);
  if (!isGraphQL(rawUrl)) return null;

  let resolvedUrl = rawUrl;
  try {
    resolvedUrl = new URL(rawUrl, win.location.href).href;
  } catch {}

  let body: string | null = null;
  if (typeof init?.body === 'string') {
    body = init.body;
  } else if (isRequest && !input.bodyUsed && typeof input.clone === 'function') {
    try {
      body = await input.clone().text();
    } catch {}
  }
  if (typeof body !== 'string') return null;

  const parsed = parseBody(body);
  if (!parsed) return null;

  const HeadersCtor = win.Headers || Headers;
  const desc = {
    url: resolvedUrl,
    method,
    body,
    headers: new HeadersCtor(init?.headers ?? (isRequest ? input.headers : undefined)),
    credentials: init?.credentials ?? (isRequest ? input.credentials : undefined) ?? 'same-origin',
    mode: init?.mode ?? (isRequest ? input.mode : undefined) ?? 'cors',
    cache: init?.cache ?? (isRequest ? input.cache : undefined)
  };

  const authHeader = desc.headers.get('authorization');
  if (authHeader && /^Bearer\s+/i.test(authHeader) && !coreHooks?.isSessionClearing()) {
    coreHooks?.setAuthHeader(authHeader);
  }
  const mediaList = isMediaListQuery(parsed);
  const bypass = noStore(desc) || (!mediaList && isVolatile(parsed));
  return { desc, parsed, mutation: isMutation(parsed), bypass };
}

export function cachedFetch(
  nativeFetch: any,
  job: any,
  input: any,
  init?: RequestInit,
  alflMode?: string | boolean
) {
  const { desc, parsed } = job;
  if (init?.signal?.aborted) return nativeFetch(input, init);
  const skipLearn = alflMode === true || alflMode === 'replay' || alflMode === 'internal';
  if (!skipLearn) attempt(() => rememberQuery(desc, parsed));

  if (isRpcBlocked(parsed?.query, parsed?.variables)) {
    fastLoadLog?.debug('Blocked GQL fetch:', JSON.stringify(parsed?.variables));
    const dummy = {
      data: {
        Page: {
          pageInfo: { total: 0, perPage: 30, currentPage: parsed?.variables?.page || 1, lastPage: 1, hasNextPage: false },
          mediaList: []
        }
      }
    };
    const ResponseCtor = win.Response || Response;
    return Promise.resolve(
      new ResponseCtor(JSON.stringify(dummy), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  }

  let key = '';
  let ttl = CFG.gqlTtl;
  try {
    key = makeKey(desc, parsed);
    ttl = getQueryTtl(parsed);
  } catch {
    return nativeFetch(input, init);
  }
  const now = Date.now();

  const cached = store.get(key);
  const taxStorageKey = getTaxonomyStorageKey(parsed);

  if (taxStorageKey) {
    const storedTax = loadStoredTaxonomy(taxStorageKey);
    if (storedTax && now - storedTax.time < TAXONOMY_TTL) {
      stats.cacheHits++;
      fastLoadLog?.debug('Cache HIT (24h storage):', getTaxonomyKind(parsed));
      const HeadersCtor = win.Headers || Headers;
      const ResponseCtor = win.Response || Response;
      return Promise.resolve(
        new ResponseCtor(storedTax.text, {
          status: storedTax.status || 200,
          statusText: storedTax.statusText || 'OK',
          headers: new HeadersCtor(storedTax.headers)
        })
      );
    }
  }

  if (cached && cached.time >= freshFloor && now - cached.time < ttl) {
    stats.cacheHits++;
    fastLoadLog?.debug(
      'Cache HIT (RAM):',
      isMediaListQuery(parsed) ? 'MediaListCollection' : 'GraphQL query',
      `${Math.round((now - cached.time) / 1000)}s old`
    );
    return Promise.resolve(toResponse(cached.snap));
  }

  type SnapshotResult = { snap: any; cacheable: boolean };
  const flying = inflight.get(key) as Promise<SnapshotResult | null> | undefined;
  if (flying) {
    stats.deduped++;
    fastLoadLog?.debug(
      'Attached to in-flight request:',
      isMediaListQuery(parsed) ? 'MediaListCollection' : 'GraphQL query'
    );
    return abortable(
      flying.then(
        (result) => {
          if (result) return toResponse(result.snap);
          if (init?.signal?.aborted) {
            throw (init.signal as any).reason ?? new DOMException('The operation was aborted.', 'AbortError');
          }
          if (Date.now() < pausedUntil) {
            throw new Error('FastLoad paused due to rate limit');
          }
          return nativeFetch(input, init);
        },
        (err: any) => {
          if (init?.signal?.aborted) {
            throw (init.signal as any).reason ?? new DOMException('The operation was aborted.', 'AbortError');
          }
          if (Date.now() < pausedUntil) {
            throw err;
          }
          return nativeFetch(input, init);
        }
      ),
      init?.signal
    );
  }

  const myEpoch = epoch;
  const stale = cached && now - cached.time < CFG.gqlStaleTtl ? cached.snap : null;
  const opName = parsed.operationName || (isMediaListQuery(parsed) ? 'MediaListCollection' : 'query');
  fastLoadLog?.debug(
    alflMode === 'replay' ? 'Cache MISS (prefetch fetch):' : 'Cache MISS (network fetch):',
    opName,
    'key:',
    key
  );
  const original = trackedNativeFetch(nativeFetch, job, input, init);

  const snapshot: Promise<SnapshotResult | null> = original.then(async (res: Response) => {
    note429(res);
    if (res.bodyUsed || typeof res.clone !== 'function') {
      fastLoadLog?.debug('Response not cacheable:', res.status, opName);
      return null;
    }
    const copy = res.clone();
    const buf = await copy.arrayBuffer();
    const hasErrors = res.status === 200 ? hasGraphQLErrors(buf) : false;
    const cacheable = res.status === 200 && !hasErrors;
    if (!cacheable) {
      fastLoadLog?.debug(
        res.status !== 200 ? 'Response not cacheable:' : 'Response had GraphQL errors:',
        res.status,
        opName
      );
    }
    const snap = {
      buf,
      status: res.status,
      statusText: res.statusText,
      headers: [...(res.headers as any).entries()].filter(
        ([k]: [string]) => !SKIP_HEADERS.test(k) && (!cacheable || !RATE_HEADERS.test(k))
      )
    };
    return { snap, cacheable };
  });

  inflight.set(key, snapshot);
  snapshot.then(
    (result) => {
      if (inflight.get(key) === snapshot) inflight.delete(key);
      if (!result || !result.cacheable) return;
      const { snap } = result;
      if (epoch === myEpoch) {
        put(key, snap);
        fastLoadLog?.debug('Cached in RAM:', opName, `${Math.round(snap.buf.byteLength / 1024)} KB`);
      }
      attempt(() => {
        if (isViewerQuery(parsed)) {
          extractUsersFromRpcResult(JSON.parse(decoder.decode(snap.buf))?.data);
        }
      });
      if (taxStorageKey && snap.status === 200) {
        persistStoredTaxonomy(taxStorageKey, snap);
      }
    },
    () => {
      if (inflight.get(key) === snapshot) inflight.delete(key);
    }
  );

  if (!stale) return original;

  return original.then(
    (res: Response) => {
      if (res.status === 429 || res.status >= 500) {
        stats.staleServed++;
        return toResponse(stale, res);
      }
      return res;
    },
    (err: any) => {
      if (init?.signal?.aborted || err?.name === 'AbortError') throw err;
      stats.staleServed++;
      return toResponse(stale);
    }
  );
}

function trackedNativeFetch(nativeFetch: any, job: any, input: any, init?: RequestInit): Promise<Response> {
  const subscribeActive = coreHooks?.hasGqlFetchSubscribers();
  const { desc, parsed } = job;
  const query = String(parsed?.query || '');
  const variables = parsed?.variables && typeof parsed.variables === 'object' ? parsed.variables : {};
  const operationName = typeof parsed?.operationName === 'string' ? parsed.operationName : undefined;
  const url = String(desc?.url || '');

  if (subscribeActive && query) {
    coreHooks!.emitGqlFetch({
      phase: 'request',
      url,
      query,
      variables,
      operationName
    });
  }

  const p: Promise<Response> = nativeFetch(input, init);

  if (subscribeActive && query) {
    p.then(
      async (res: Response) => {
        let data: any = undefined;
        let errors: readonly { message?: string; [key: string]: any }[] | undefined = undefined;
        if (res && !res.bodyUsed && typeof res.clone === 'function') {
          try {
            const json = await res.clone().json();
            data = json?.data;
            errors = Array.isArray(json?.errors) ? json.errors : undefined;
          } catch {}
        }
        coreHooks?.emitGqlFetch({
          phase: 'response',
          url,
          query,
          variables,
          operationName,
          status: res.status,
          ok: res.ok,
          data,
          errors
        });
      },
      () => {}
    );
  }

  return p;
}

export function installGraphQLLayer(yielded: () => boolean): () => void {
  const nativeFetch = win.fetch.bind(win);

  const wrappedFetch = async function fetch(input: any, init?: RequestInit) {
    if (yielded()) return nativeFetch(input, init);
    let job = null;
    try {
      job = await classify(input, init);
    } catch {
      /* fall back to native */
    }
    if (!job) return nativeFetch(input, init);
    stats.graphqlRequests++;

    if (job.mutation) {
      clearGlobalCache();
      const p = trackedNativeFetch(nativeFetch, job, input, init);
      p.then(
        (res: Response) => {
          note429(res);
          clearGlobalCache();
        },
        () => clearGlobalCache()
      );
      return p;
    }
    if (job.bypass) {
      const p = trackedNativeFetch(nativeFetch, job, input, init);
      p.then(note429, () => {});
      return p;
    }
    return cachedFetch(nativeFetch, job, input, init, (init as any)?.__alfl);
  };

  win.fetch = wrappedFetch;
  return () => {
    if (win.fetch === wrappedFetch) {
      win.fetch = nativeFetch;
    }
  };
}
