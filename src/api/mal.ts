import { registerAccountProvider } from '../core/accounts';
import { showToast } from '../core/toast';
import { createSharedFlight, type SharedFlight } from '../utils/flight';
import {
  authError,
  createAbortError,
  createCoreLogger,
  gm,
  isAbortError,
  openTab,
  raceWithSignal,
  randomString,
  sleep,
  store
} from '../utils/helpers';
import { RateLimiter } from '../utils/limiter';

export interface MalCallOptions {
  checkCancel?: () => void;
  signal?: AbortSignal;
}

export const strictTitle = (s: string | null | undefined): string =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’‘'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const malLog = createCoreLogger('mal');

export const MAL_AUTH_URL = 'https://myanimelist.net/v1/oauth2/authorize';
export const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
export const MAL_API = 'https://api.myanimelist.net/v2';
export const MAL_REDIRECT = 'https://myanimelist.net/';
export const MAL_CLIENT_ID = 'f8197fe8cb24188073de4c0227307edf';
export const MAL_CLIENT_SECRET = '';
export const MAL_SECRET_KEYS = [
  'mal_code_verifier',
  'mal_token',
  'mal_refresh_token',
  'mal_expires_at'
] as const;

export const hooks: { checkCancel?: () => void } = {};

export let logLines: string[] = [];
export let lastNotice = '';

export interface MalUiSink {
  onLog?: (entry: { line: string; message: string; level: 'info' | 'warn' | 'error' | 'success' }) => void;
  onToast?: (msg: string, isError?: boolean, closeTab?: boolean) => void;
}

let uiSink: MalUiSink | null = null;

export function setMalUiSink(sink: MalUiSink | null): () => void {
  uiSink = sink;
  return () => {
    if (uiSink === sink) uiSink = null;
  };
}

export function log(msg: any, level: 'info' | 'warn' | 'error' | 'success' = 'info'): void {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const marker = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN ' : level === 'success' ? 'OK   ' : 'INFO ';
  const line = `${time}  ${marker} ${String(msg)}`;
  logLines.unshift(line);
  logLines = logLines.slice(0, 60);
  if (level === 'error') malLog.error(msg);
  else if (level === 'warn') malLog.warn(msg);
  else malLog.debug(msg);
  lastNotice = String(msg);
  try {
    uiSink?.onLog?.({ line, message: lastNotice, level });
  } catch (e) {
    malLog.error('uiSink.onLog failed:', e);
  }
}

export function toast(msg: string, isError?: boolean, closeTab?: boolean): void {
  log(msg, isError ? 'error' : 'info');
  try {
    if (uiSink?.onToast) {
      uiSink.onToast(msg, isError, closeTab);
      return;
    }
  } catch (e) {
    malLog.error('uiSink.onToast failed:', e);
  }
  showToast(msg, { type: isError ? 'error' : 'success', closeTab });
}

export const clearMalAuth = (): void => {
  ['mal_token', 'mal_refresh_token', 'mal_expires_at'].forEach((k) => store.del(k));
};

export async function malTokenRequest(params: Record<string, string>): Promise<string> {
  const body = new URLSearchParams({ client_id: MAL_CLIENT_ID, ...params });
  if (MAL_CLIENT_SECRET) body.set('client_secret', MAL_CLIENT_SECRET);
  const res = await gm.request(MAL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: body.toString()
  });
  let json: any = {};
  try {
    json = JSON.parse(res.responseText);
  } catch (_) {}
  if (typeof json.access_token !== 'string' || !json.access_token) {
    if (params.grant_type === 'refresh_token' && [400, 401, 403].includes(res.status)) {
      clearMalAuth();
      throw authError('MAL', 'MAL session expired — reconnect MAL.');
    }
    throw new Error(json.hint || json.message || json.error || res.responseText || `HTTP ${res.status}`);
  }
  store.set('mal_token', json.access_token);
  if (typeof json.refresh_token === 'string' && json.refresh_token) {
    store.set('mal_refresh_token', json.refresh_token);
  }
  const expiresIn = Number(json.expires_in);
  store.set('mal_expires_at', Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000);
  return json.access_token;
}

export async function exchangeMalCode(code: string): Promise<string> {
  const token = await malTokenRequest({
    code,
    code_verifier: store.get('mal_code_verifier', ''),
    grant_type: 'authorization_code',
    redirect_uri: MAL_REDIRECT
  });
  store.del('mal_code_verifier');
  return token;
}

let malRefresh: Promise<string> | null = null;

function isStoredTokenValid(token: unknown, expiresAt: unknown, failedToken?: string): token is string {
  return (
    typeof token === 'string' &&
    token.length > 0 &&
    typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt) &&
    token !== failedToken &&
    Date.now() < expiresAt - 60000
  );
}

export async function malEnsureToken(failedToken?: string): Promise<string> {
  if (malRefresh) return malRefresh;

  const current = store.get<unknown>('mal_token', null);
  const expiresAt = store.get<unknown>('mal_expires_at', 0);
  if (isStoredTokenValid(current, expiresAt, failedToken)) return current;

  malRefresh = (async () => {
    const latest = store.get<unknown>('mal_token', null);
    const latestExp = store.get<unknown>('mal_expires_at', 0);
    if (isStoredTokenValid(latest, latestExp, failedToken)) return latest;
    const refresh = store.get<unknown>('mal_refresh_token', null);
    if (typeof refresh !== 'string' || !refresh) {
      throw authError('MAL', 'No MAL refresh token stored — reconnect MAL.');
    }
    return malTokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  })().finally(() => {
    malRefresh = null;
  });
  return malRefresh;
}

export function malConnect(): void {
  const verifier = randomString(96);
  store.set('mal_code_verifier', verifier);
  openTab(
    `${MAL_AUTH_URL}?response_type=code&client_id=${encodeURIComponent(MAL_CLIENT_ID)}&code_challenge=${encodeURIComponent(
      verifier
    )}&code_challenge_method=plain&redirect_uri=${encodeURIComponent(MAL_REDIRECT)}`
  );
  log('Opened MAL authorization in a new tab. Finish connecting there, then return to your list.');
}

export function captureCredentials(): void {
  if (location.hostname === 'myanimelist.net') {
    const code = new URLSearchParams(location.search).get('code');
    if (!code || !store.get('mal_code_verifier')) return;
    exchangeMalCode(code)
      .then(() => {
        const url = new URL(location.href);
        url.searchParams.delete('code');
        url.searchParams.delete('state');
        history.replaceState(null, '', url.pathname + url.search);
        toast('MAL connected! You can close this tab.', false, true);
      })
      .catch((e) => toast('MAL connection failed: ' + e.message, true));
  }
}

export const isMalConnected = (): boolean => !!store.get('mal_token', null);

registerAccountProvider({
  id: 'mal',
  name: 'MyAnimeList',
  secretKeys: MAL_SECRET_KEYS,
  isConnected: () => isMalConnected(),
  connect: () => malConnect(),
  disconnect: () => clearMalAuth(),
  onAuthCallback: () => captureCredentials()
});

export const malLimiter = new RateLimiter({
  rate: 60,
  min: 12,
  max: 180,
  burst: 4,
  adaptive: true,
  jitter: true,
  persistKey: 'ala_mal_api_resume_at'
});

const BREAKER_THRESHOLD = 8;
const BREAKER_COOLDOWN_MS = 90e3;

function createMalAbortError(signal?: AbortSignal): Error & { cancelled: boolean } {
  const reason = (signal as { reason?: unknown } | undefined)?.reason;
  const base = reason instanceof Error ? reason : createAbortError(signal);
  const tagged = base as Error & { cancelled?: boolean };
  if (!tagged.cancelled) {
    try {
      tagged.cancelled = true;
    } catch {
      return Object.assign(new Error(base.message), { name: base.name, cancelled: true });
    }
  }
  return tagged as Error & { cancelled: boolean };
}

function rethrowMalAbort(err: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) {
    throw createMalAbortError(signal);
  }
  if (isAbortError(err)) {
    const tagged = err as Error & { cancelled?: boolean };
    if (!tagged.cancelled) {
      try {
        tagged.cancelled = true;
      } catch {
        throw Object.assign(new Error(tagged.message), { name: tagged.name, cancelled: true });
      }
    }
    throw tagged;
  }
  throw err;
}

function sleepMal(ms: number, signal?: AbortSignal): Promise<void> {
  return sleep(ms, signal).catch((err) => rethrowMalAbort(err, signal));
}

function normalizeMalCallOptions(cancelOrOpts?: (() => void) | MalCallOptions): {
  checkFn?: () => void;
  signal?: AbortSignal;
  check: () => void;
} {
  const opts: MalCallOptions | undefined =
    typeof cancelOrOpts === 'function' ? { checkCancel: cancelOrOpts } : cancelOrOpts;
  const hasExplicit = Boolean(opts?.checkCancel || opts?.signal);
  const checkFn = opts?.checkCancel ?? (hasExplicit ? undefined : () => hooks.checkCancel?.());
  const signal = opts?.signal;
  const check = (): void => {
    checkFn?.();
    if (signal?.aborted) throw createMalAbortError(signal);
  };
  return { checkFn, signal, check };
}

export const breaker = (() => {
  let fails = 0;
  let until = 0;
  let trips = 0;
  return {
    ok() {
      fails = 0;
    },
    fail() {
      if (++fails >= BREAKER_THRESHOLD && Date.now() >= until) {
        fails = 0;
        trips++;
        until = Date.now() + BREAKER_COOLDOWN_MS;
        log(`⚠ ${BREAKER_THRESHOLD} consecutive MAL failures — pausing writes for ${BREAKER_COOLDOWN_MS / 1000}s.`);
      }
    },
    async wait(cancelOrOpts?: (() => void) | MalCallOptions) {
      const { check, signal } = normalizeMalCallOptions(cancelOrOpts);
      while (Date.now() < until) {
        check();
        await sleepMal(Math.min(1000, until - Date.now()), signal);
      }
      check();
    },
    get trips() {
      return trips;
    },
    reset() {
      fails = 0;
      until = 0;
      trips = 0;
    }
  };
})();

export class MalError extends Error {
  status: number;
  html: boolean;
  constructor(what: string, res: any) {
    super(`${what} ${res.status}: ${String(res.responseText || 'request failed').slice(0, 200)}`);
    this.status = res.status;
    this.html = /^\s*</.test(res.responseText || '');
  }
}

export function parseRetryAfterMs(headers: string, fallback: number): number {
  const m = String(headers || '').match(/retry-after:\s*([^\r\n]+)/i);
  if (!m) return fallback;
  const raw = m[1].trim();
  if (!raw) return fallback;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(1000, Math.min(secs * 1000, 120000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(1000, Math.min(date - Date.now(), 120000)) : fallback;
}

export const looksLimited = (res: any): boolean =>
  res.status === 429 || (res.status === 403 && /^\s*</.test(res.responseText || ''));

const backoff = (attempt: number) => Math.min(30000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);

async function malRequestWithToken(
  {
    method = 'GET',
    url,
    data,
    headers = {},
    timeout = 30000
  }: { method?: string; url: string; data?: any; headers?: any; timeout?: number },
  cancelOrOpts?: (() => void) | MalCallOptions,
  failedToken?: string,
  onTokenResolved?: () => void
): Promise<{ res: any; token: string }> {
  const { check, signal } = normalizeMalCallOptions(cancelOrOpts);
  await malLimiter.acquire({ check, signal }).catch((err) => rethrowMalAbort(err, signal));
  check();
  const token = await raceWithSignal(malEnsureToken(failedToken), signal, createMalAbortError);
  check();
  onTokenResolved?.();
  malLog.debug(`MAL ${method} ${url}`, data ? { data } : '');
  const res = await raceWithSignal(
    gm.request(url, { method, data, timeout, headers: { Authorization: `Bearer ${token}`, ...headers } }),
    signal,
    createMalAbortError
  );
  check();
  malLog.debug(`MAL ${method} response: ${res.status} for ${url}`);
  if (looksLimited(res)) malLimiter.limit(parseRetryAfterMs(res.responseHeaders, res.status === 429 ? 5000 : 60000));
  else if (res.status >= 500) malLimiter.limit(2000);
  else if (res.status >= 200 && res.status < 300) malLimiter.success();
  return { res, token };
}

export async function malRequest(
  opts: { method?: string; url: string; data?: any; headers?: any; timeout?: number },
  cancelOrOpts?: (() => void) | MalCallOptions
): Promise<any> {
  const { res } = await malRequestWithToken(opts, cancelOrOpts);
  return res;
}

export function malCall(opts: any, callOpts?: MalCallOptions): Promise<any>;
export function malCall(opts: any, retries?: number, cancelOrOpts?: (() => void) | MalCallOptions): Promise<any>;
export async function malCall(
  opts: any,
  retriesOrCallOpts: number | MalCallOptions = 4,
  cancelOrOpts?: (() => void) | MalCallOptions
): Promise<any> {
  const retries = typeof retriesOrCallOpts === 'number' ? retriesOrCallOpts : 4;
  const effectiveCancel =
    typeof retriesOrCallOpts === 'object' && retriesOrCallOpts !== null ? retriesOrCallOpts : cancelOrOpts;
  const { check, signal } = normalizeMalCallOptions(effectiveCancel);
  const forwardOpts: MalCallOptions = { checkCancel: check, signal };
  let refreshed = false;
  let failedToken: string | undefined;
  let attempt = 0;
  while (true) {
    check();
    let res: any;
    let usedToken = '';
    try {
      const out = await malRequestWithToken(opts, forwardOpts, failedToken, () => {
        failedToken = undefined;
      });
      res = out.res;
      usedToken = out.token;
    } catch (e: any) {
      if (e?.auth || e?.cancelled || isAbortError(e) || signal?.aborted || attempt >= retries) throw e;
      await sleepMal(backoff(attempt), signal);
      check();
      attempt++;
      continue;
    }
    if (res.status === 401) {
      if (refreshed) {
        clearMalAuth();
        throw authError('MAL', 'MAL rejected the access token — reconnect MAL.');
      }
      refreshed = true;
      failedToken = usedToken;
      continue;
    }
    if (!looksLimited(res) && res.status < 500) return res;
    if (attempt >= retries) return res;
    if (!looksLimited(res)) {
      check();
      await sleepMal(backoff(attempt), signal);
      check();
    }
    attempt++;
  }
}

export const parseJson = (res: any, what: string): any => {
  try {
    return JSON.parse(res.responseText || '{}');
  } catch (_) {
    throw new Error(`MAL returned invalid JSON for ${what}.`);
  }
};

export async function malUpdateEntry(
  type: 'ANIME' | 'MANGA',
  malId: number,
  patch: Record<string, any>,
  opts?: MalCallOptions
): Promise<any> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== null) body.append(k, String(v));
  }
  const res = await malCall(
    {
      method: 'PUT',
      url: `${MAL_API}/${type === 'ANIME' ? 'anime' : 'manga'}/${malId}/my_list_status`,
      data: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    },
    opts
  );
  if (res.status < 200 || res.status >= 300) throw new MalError('MAL', res);
  return res;
}

export async function malDeleteEntry(type: 'ANIME' | 'MANGA', malId: number, opts?: MalCallOptions): Promise<any> {
  const res = await malCall(
    {
      method: 'DELETE',
      url: `${MAL_API}/${type === 'ANIME' ? 'anime' : 'manga'}/${malId}/my_list_status`
    },
    opts
  );
  if (res.status === 404) return res;
  if (res.status < 200 || res.status >= 300) throw new MalError('MAL delete', res);
  return res;
}

export async function malWhoAmI(opts?: MalCallOptions): Promise<any> {
  const res = await malCall({ url: `${MAL_API}/users/@me` }, opts);
  if (res.status < 200 || res.status >= 300) throw new MalError('MAL profile', res);
  return parseJson(res, 'the profile');
}

export async function malFetchList(type: 'ANIME' | 'MANGA', opts?: MalCallOptions): Promise<Record<number, any>> {
  const MAL_LIST_PAGE_SIZE = 1000;
  const MAL_LIST_MAX = 100000;
  const { check } = normalizeMalCallOptions(opts);
  const anime = type === 'ANIME';
  const fields = anime
    ? 'num_episodes,list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched,start_date,finish_date,comments}'
    : 'num_chapters,num_volumes,list_status{status,score,num_chapters_read,num_volumes_read,is_rereading,num_times_reread,start_date,finish_date,comments}';
  const entries: Record<number, any> = {};
  let total = 0;

  for (let offset = 0; offset <= MAL_LIST_MAX; ) {
    check();
    const res = await malCall(
      {
        url: `${MAL_API}/users/@me/${anime ? 'animelist' : 'mangalist'}?fields=${encodeURIComponent(
          fields
        )}&limit=${MAL_LIST_PAGE_SIZE}&offset=${offset}&nsfw=true`,
        timeout: 60000
      },
      6,
      opts
    );
    check();
    if (res.status < 200 || res.status >= 300) throw new MalError('MAL list', res);
    const json = parseJson(res, 'the list');
    const nodes = Array.isArray(json.data) ? json.data : [];
    for (const row of nodes) {
      const id = Number(row?.node?.id);
      if (!(id > 0) || !row.list_status) continue;
      const node = row.node;
      if (!entries[id]) total++;
      entries[id] = {
        ...row.list_status,
        __malTitle: node.title || '',
        __total: Number(anime ? node.num_episodes : node.num_chapters) || 0,
        __totalVolumes: anime ? 0 : Number(node.num_volumes) || 0
      };
    }
    if (total > MAL_LIST_MAX) throw new Error(`MAL list exceeded the ${MAL_LIST_MAX.toLocaleString()}-entry safety limit.`);
    if (!nodes.length || !json.paging?.next) break;
    offset += nodes.length;
  }
  return entries;
}

type SearchCandidate = { id: number; titles: string[]; year: number };
const SEARCH_CACHE_MAX = 1000;
const searchCache = new Map<string, SearchCandidate[]>();
const searchFlights = new Map<string, SharedFlight<SearchCandidate[]>>();

async function fetchSearchCandidates(
  type: 'ANIME' | 'MANGA',
  q: string,
  opts: MalCallOptions
): Promise<SearchCandidate[]> {
  const params = new URLSearchParams({
    q: q.slice(0, 64),
    limit: '10',
    nsfw: 'true',
    fields: 'alternative_titles,start_date'
  });
  const res = await malCall({ url: `${MAL_API}/${type === 'ANIME' ? 'anime' : 'manga'}?${params}` }, 2, opts);
  if (res.status === 400) return [];
  if (res.status < 200 || res.status >= 300) throw new MalError('MAL search', res);
  const json = parseJson(res, 'a search');
  return (Array.isArray(json.data) ? json.data : []).map((r: any) => {
    const n = r?.node || {};
    const alt = n.alternative_titles || {};
    return {
      id: Number(n.id) || 0,
      titles: [n.title, alt.en, alt.ja, ...(alt.synonyms || [])].map(strictTitle).filter(Boolean),
      year: Number(String(n.start_date || '').slice(0, 4)) || 0
    };
  });
}

export async function searchCandidates(
  key: string | number,
  type: 'ANIME' | 'MANGA',
  q: string,
  opts?: MalCallOptions
): Promise<SearchCandidate[]> {
  const { check, signal } = normalizeMalCallOptions(opts);
  check();
  const k = String(key);
  if (searchCache.has(k)) {
    return searchCache.get(k)!;
  }

  let flight = searchFlights.get(k);
  if (!flight || flight.controller.signal.aborted) {
    flight = createSharedFlight<SearchCandidate[]>({
      start: (controllerSignal) => {
        const flightOpts: MalCallOptions = {
          checkCancel: () => {
            if (controllerSignal.aborted) throw createMalAbortError(controllerSignal);
          },
          signal: controllerSignal
        };
        return fetchSearchCandidates(type, q, flightOpts).then((cands) => {
          if (!controllerSignal.aborted) {
            if (searchCache.size >= SEARCH_CACHE_MAX) {
              searchCache.delete(searchCache.keys().next().value as string);
            }
            searchCache.set(k, cands);
          }
          return cands;
        });
      },
      onEvict: (evicted) => {
        if (searchFlights.get(k) === evicted) {
          searchFlights.delete(k);
        }
      },
      onSettled: (doneFlight) => {
        if (searchFlights.get(k) === doneFlight) {
          searchFlights.delete(k);
        }
      },
      createAbortError: createMalAbortError
    });
    searchFlights.set(k, flight);
  }

  return flight.wait({ signal, check });
}

export async function searchMalId(type: 'ANIME' | 'MANGA', entry: any, opts?: MalCallOptions): Promise<number> {
  const { check } = normalizeMalCallOptions(opts);
  check();
  for (const q of (entry.queryTitles as string[]).filter((s) => s.length >= 3).slice(0, 2)) {
    check();
    const cands = await searchCandidates(`${type}:${q}`, type, q, opts);
    check();
    const ok = cands.filter(
      (c: any) =>
        c.id &&
        c.titles.some((t: string) => entry.titles.includes(t)) &&
        (!c.year || !entry.startYear || Math.abs(c.year - entry.startYear) <= 1)
    );
    if (ok.length === 1) return ok[0].id;
    if (ok.length > 1) {
      const exact = ok.filter((c: any) => c.year && c.year === entry.startYear);
      return exact.length === 1 ? exact[0].id : 0;
    }
  }
  return 0;
}
