import {
  win,
  doc,
  coreHooks,
  coreSession,
  coreStorage,
  fastLoadLog,
  fastLoadRpcLog,
  userMap,
  pausedUntil,
  getViewerFromWindow,
  getLocalUsername,
  onCacheClear
} from './state';
import { CFG, stats, attempt } from './config';
import { isGraphQL } from './graphql';
import { isMutation, isVolatile } from './helpers';
import { lastAuth, prefetchWorkerList } from './worker';
import type { CleanupFn, DebouncedFn, FeatureContext } from '../../types';

const sameId = (a: any, b: any) =>
  a === b || (typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase());

const isIdKey = (key: string) => /^(?:id|name|userName|username|userId)$|Id$/.test(key);
const STATIC_ROUTE = /^\/(?:home|search\/(?:anime|manga))\/?$/;

function safeDecodeURIComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseRoute(path: string, search = '') {
  const parts = path
    .split('/')
    .filter(Boolean)
    .map(safeDecodeURIComponent);
  if (['anime', 'manga', 'character', 'staff', 'studio'].includes(parts[0]) && /^\d+$/.test(parts[1] || '')) {
    return { shape: `${parts[0]}/${parts[3] || ''}`, id: Number(parts[1]) };
  }
  if (parts[0] === 'user' && parts[1]) return { shape: `user/${parts[2] || ''}`, id: parts[1] };
  if (parts[0] === 'animelist' || parts[0] === 'mangalist') {
    const myName = getLocalUsername();
    if (myName) return { shape: `user/${parts[0]}`, id: myName };
  }
  if (STATIC_ROUTE.test(path))
    return { shape: `static:${path.replace(/\/$/, '')}${search}`, id: null, static: true };
  return null;
}

export const here = () => parseRoute(win.location.pathname, win.location.search);

export function hasPageId(value: any, id: any): boolean {
  if (!value || typeof value !== 'object') return false;
  const targetUserId = typeof id === 'string' ? userMap.get(id.toLowerCase()) : undefined;
  return Object.keys(value).some((key) => {
    const x = value[key];
    if (x && typeof x === 'object') return hasPageId(x, id);
    if (isIdKey(key)) {
      if (sameId(x, id)) return true;
      if (targetUserId != null && (key === 'userId' || key === 'id') && x === targetUserId) return true;
    }
    return false;
  });
}

export function replacePageId(value: any, from: any, to: any): number {
  if (!value || typeof value !== 'object') return 0;
  const fromUserId = typeof from === 'string' ? userMap.get(from.toLowerCase()) : undefined;
  const toUserId = typeof to === 'string' ? userMap.get(to.toLowerCase()) : undefined;
  let count = 0;
  for (const key of Object.keys(value)) {
    const x = value[key];
    if (x && typeof x === 'object') count += replacePageId(x, from, to);
    else if (isIdKey(key)) {
      if (sameId(x, from)) {
        value[key] = to;
        count++;
      } else if (fromUserId != null && toUserId != null && (key === 'userId' || key === 'id') && x === fromUserId) {
        value[key] = toUserId;
        count++;
      }
    }
  }
  return count;
}

export const learned = new Map<string, any>();
const ROUTES_KEY = 'routes:v4';
const ROUTES_TTL = 30 * 86400e3;

export interface RouteTimerApi {
  timeout: FeatureContext['timeout'];
  debounce: FeatureContext['debounce'];
}

let routesDisposed = false;
let routeTimers: RouteTimerApi | null = null;
let persistDebounced: DebouncedFn<() => void> | null = null;
let autoPrefetchCancel: CleanupFn | null = null;
let dwellCancel: CleanupFn | null = null;
const pendingAutoPrefetchCancels = new Set<CleanupFn>();

function writeLearnedRoutes(): void {
  if (routesDisposed) return;
  attempt(() => {
    const out: Record<string, any> = {};
    for (const [shape, v] of [...learned].slice(-40))
      out[shape] = { t: v.t, id: v.route.id, static: !!v.route.static, reqs: v.reqs };
    coreStorage?.set(ROUTES_KEY, out);
  });
}

function clearPendingAutoPrefetchTimers(): void {
  for (const cancel of pendingAutoPrefetchCancels) {
    cancel();
  }
  pendingAutoPrefetchCancels.clear();
}

export function initRoutes(timers?: RouteTimerApi): void {
  routesDisposed = false;
  if (timers) {
    persistDebounced?.cancel();
    routeTimers = timers;
    persistDebounced = timers.debounce(writeLearnedRoutes, 1000);
  }
}

export function cleanupRoutes(disposeTimers = false): void {
  routesDisposed = true;
  persistDebounced?.cancel();
  autoPrefetchCancel?.();
  autoPrefetchCancel = null;
  dwellCancel?.();
  dwellCancel = null;
  clearPendingAutoPrefetchTimers();
  if (disposeTimers) {
    routeTimers = null;
    persistDebounced = null;
    learned.clear();
    prefetched.clear();
    stamps.length = 0;
    learning = { key: '', started: 0, route: null, reqs: [] };
  }
}

export const persistRoutes = () => {
  if (routesDisposed) return;
  persistDebounced?.();
};

export function loadRoutes() {
  attempt(() => {
    const raw = coreStorage?.get<any>(ROUTES_KEY, null);
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (data && typeof data === 'object') {
      const now = Date.now();
      for (const [shape, v] of Object.entries(data) as any) {
        if (!v || !Array.isArray(v.reqs) || typeof v.t !== 'number' || now - v.t > ROUTES_TTL) continue;
        const reqs = v.reqs.filter(
          (r: any) =>
            r &&
            typeof r.body === 'string' &&
            typeof r.url === 'string' &&
            isGraphQL(r.url) &&
            r.headers &&
            typeof r.headers === 'object'
        );
        if (reqs.length) learned.set(shape, { route: { shape, id: v.id, static: !!v.static }, reqs, t: v.t });
      }
    }
  });
}

let learning: { key: string; started: number; route: any; reqs: any[] } = {
  key: '',
  started: 0,
  route: null,
  reqs: []
};

export function refreshLearning() {
  const key = win.location.pathname + (STATIC_ROUTE.test(win.location.pathname) ? win.location.search : '');
  if (learning.key === key) return;
  learning = { key, started: 0, route: here(), reqs: [] };
}

export function rememberQuery(desc: any, parsed: any) {
  refreshLearning();
  if (!(CFG.prefetch || CFG.earlyStart) || !learning.route) return;
  if (!learning.started) learning.started = Date.now();
  if (Date.now() - learning.started > CFG.learnWindowMs) return;
  if (learning.reqs.length >= CFG.learnMaxReqs) return;
  if (!learning.route.static && !hasPageId(parsed.variables, learning.route.id)) return;

  const headers = Object.fromEntries(desc.headers.entries());
  delete headers['content-length'];
  delete headers['host'];
  delete headers['connection'];
  delete headers['content-encoding'];
  const authValue = headers.authorization;
  delete headers.authorization;
  let auth = false;
  if (authValue !== undefined) {
    auth = true;
  }
  learning.reqs.push({
    url: desc.url,
    body: JSON.stringify(parsed),
    headers,
    auth,
    credentials: desc.credentials || 'same-origin',
    mode: desc.mode || 'cors'
  });
  learned.delete(learning.route.shape);
  learned.set(learning.route.shape, { route: learning.route, reqs: [...learning.reqs], t: Date.now() });

  if (learning.route.shape === 'user/animelist') {
    const mangaReqs = learning.reqs.map((r) => ({
      ...r,
      body: r.body.replace(/"type"\s*:\s*"ANIME"/g, '"type":"MANGA"')
    }));
    learned.set('user/mangalist', {
      route: { shape: 'user/mangalist', id: learning.route.id, static: false },
      reqs: mangaReqs,
      t: Date.now()
    });
  } else if (learning.route.shape === 'user/mangalist') {
    const animeReqs = learning.reqs.map((r) => ({
      ...r,
      body: r.body.replace(/"type"\s*:\s*"MANGA"/g, '"type":"ANIME"')
    }));
    learned.set('user/animelist', {
      route: { shape: 'user/animelist', id: learning.route.id, static: false },
      reqs: animeReqs,
      t: Date.now()
    });
  }

  persistRoutes();
}

function getReplayAuthToken(): string | null {
  if (lastAuth) return lastAuth.replace(/^Bearer\s+/i, '').trim();
  const storedHeader = coreHooks?.getAuthHeader();
  if (storedHeader) return storedHeader.replace(/^Bearer\s+/i, '').trim();
  return null;
}

const stamps: number[] = [];

export function replayRoute(known: any, route: any, yielded: () => boolean) {
  if (routesDisposed || yielded()) return 0;
  let sent = 0;
  for (const request of known.reqs) {
    let parsed;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      continue;
    }
    if (isMutation(parsed) || isVolatile(parsed)) continue;
    if (!known.route.static && !sameId(known.route.id, route.id)) {
      if (!replacePageId(parsed.variables, known.route.id, route.id)) continue;
    }
    const body = JSON.stringify(parsed);

    const headers = { ...request.headers };
    if (request.auth) {
      const token = getReplayAuthToken();
      if (!token) continue;
      headers.authorization = `Bearer ${token}`;
    }
    stamps.push(Date.now());
    sent++;
    attempt(() => {
      fastLoadLog?.debug('Replay/Prefetch dispatching for:', route.shape, 'vars:', parsed.variables);
      win
        .fetch(request.url, {
          method: 'POST',
          headers,
          body,
          credentials: request.credentials || 'same-origin',
          mode: request.mode || 'cors',
          __alfl: 'replay'
        } as any)
        .catch(() => {});
    });
  }
  return sent;
}

export const triggerEarlyStart = (yielded: () => boolean) => {
  attempt(() => {
    if (routesDisposed || (navigator as any).connection?.saveData) return;
    const route = here();
    const known = route && learned.get(route.shape);
    if (known) stats.earlyStarts += replayRoute(known, route, yielded);
  });
};

const prefetched = new Map<string, number>();
onCacheClear(() => prefetched.clear());

export function prefetchFor(anchor: HTMLAnchorElement, yielded: () => boolean) {
  if (routesDisposed || yielded() || coreHooks?.isPrefetchSuppressed()) return;
  const now = Date.now();
  if (doc.hidden || now < pausedUntil || (navigator as any).connection?.saveData) return;

  let url;
  try {
    url = new URL(anchor.href, win.location.href);
  } catch {
    return;
  }
  if (url.origin !== win.location.origin) return;

  const listMatch = url.pathname.match(/^\/(?:user\/([^/]+)\/)?(animelist|mangalist)/i);
  if (listMatch) {
    const decodedUser = listMatch[1] ? safeDecodeURIComponent(listMatch[1]) : '';
    const targetUser = decodedUser || getLocalUsername();
    const listType = listMatch[2].toLowerCase() === 'mangalist' ? 'MANGA' : 'ANIME';
    const myId = coreSession?.peek().userId || 0;
    const userId = targetUser
      ? (userMap.get(targetUser.toLowerCase()) || (targetUser.toLowerCase() === getLocalUsername()?.toLowerCase() ? myId : 0))
      : 0;
    if (userId || targetUser) {
      prefetchWorkerList(listType, userId, targetUser || undefined, yielded);
    }
    return;
  }

  const route = parseRoute(url.pathname, url.search);
  if (!route || route.static) return;
  const known = learned.get(route.shape);
  if (!known || known.route.static) return;
  if (typeof known.route.id !== typeof route.id) {
    if (typeof known.route.id === 'number' && typeof route.id === 'string') {
      if (userMap.get(route.id.toLowerCase()) !== known.route.id) return;
    } else if (typeof known.route.id === 'string' && typeof route.id === 'number') {
      if (userMap.get(known.route.id.toLowerCase()) !== route.id) return;
    } else {
      return;
    }
  }

  const current = here();
  if (current && current.shape === route.shape && sameId(current.id, route.id)) return;

  const key = `${route.shape}|${String(route.id).toLowerCase()}`;
  const cooldown = route.shape.includes('list') ? 60_000 : CFG.gqlTtl;
  if (now - (prefetched.get(key) || 0) < cooldown) return;

  while (stamps.length && now - stamps[0] > 60_000) stamps.shift();
  if (prefetched.size > 200) {
    for (const [k, t] of prefetched) if (now - t > cooldown) prefetched.delete(k);
    while (prefetched.size > 200) {
      const oldest = prefetched.keys().next().value;
      if (oldest === undefined) break;
      prefetched.delete(oldest);
    }
  }
  if (stamps.length + known.reqs.length > CFG.prefetchMaxPerMin) return;

  const sent = replayRoute(known, route, yielded);
  if (sent) {
    prefetched.set(key, now);
    stats.prefetched += sent;
    fastLoadLog?.debug('Prefetch sent for:', route.shape, route.id);
  }
}

function canRunAutoPrefetch(yielded: () => boolean): boolean {
  if (routesDisposed || !CFG.prefetch || yielded() || coreHooks?.isPrefetchSuppressed()) return false;
  const now = Date.now();
  if (doc.hidden || now < pausedUntil || (navigator as any).connection?.saveData) return false;
  if (win.location.pathname.toLowerCase().includes('/compare')) return false;
  return true;
}

export function scheduleAutoPrefetch(yielded: () => boolean, delay = 600) {
  autoPrefetchCancel?.();
  autoPrefetchCancel = null;
  clearPendingAutoPrefetchTimers();
  if (routesDisposed || !routeTimers) return;
  autoPrefetchCancel = routeTimers.timeout(() => {
    autoPrefetchCancel = null;
    if (routesDisposed) return;
    attempt(() => autoPrefetchListsForCurrentRoute(yielded));
  }, delay);
}

export function autoPrefetchListsForCurrentRoute(yielded: () => boolean) {
  clearPendingAutoPrefetchTimers();
  if (!canRunAutoPrefetch(yielded)) return;

  const path = win.location.pathname;
  const scheduledPath = path;
  const viewer = getViewerFromWindow();
  const myId = viewer.id;
  const myName = viewer.name || null;

  const userMatch = path.match(/^\/user\/([^/]+)(?:\/([^/]+))?/i);
  let isAnotherUserPage = false;
  let otherUser = '';
  let otherUserId = 0;
  let subRoute = '';

  if (userMatch) {
    const targetUser = safeDecodeURIComponent(userMatch[1]);
    subRoute = (userMatch[2] || '').toLowerCase();
    const isMe =
      (myName && targetUser.toLowerCase() === myName.toLowerCase()) ||
      (myId > 0 && userMap.get(targetUser.toLowerCase()) === myId);

    if (!isMe) {
      isAnotherUserPage = true;
      otherUser = targetUser;
      otherUserId = userMap.get(targetUser.toLowerCase()) || 0;
    }
  }

  const scheduleWorkerPrefetch = (
    type: 'ANIME' | 'MANGA',
    userId: number,
    userName: string | undefined,
    delay: number
  ) => {
    if (routesDisposed || !routeTimers) return;
    let settled = false;
    let cancel: CleanupFn = () => {};
    cancel = routeTimers.timeout(() => {
      settled = true;
      pendingAutoPrefetchCancels.delete(cancel);
      if (routesDisposed || win.location.pathname !== scheduledPath || !canRunAutoPrefetch(yielded)) return;
      attempt(() => prefetchWorkerList(type, userId, userName, yielded));
    }, delay);
    if (!settled) pendingAutoPrefetchCancels.add(cancel);
  };

  if (isAnotherUserPage) {
    fastLoadRpcLog?.debug('Auto-prefetching for target user:', otherUser, 'subRoute:', subRoute);
    if (subRoute !== 'animelist') {
      scheduleWorkerPrefetch('ANIME', otherUserId, otherUser, 100);
    }
    if (subRoute !== 'mangalist') {
      scheduleWorkerPrefetch('MANGA', otherUserId, otherUser, 300);
    }

    if (myId || myName) {
      scheduleWorkerPrefetch('ANIME', myId, myName || undefined, 500);
      scheduleWorkerPrefetch('MANGA', myId, myName || undefined, 800);
    }
  } else {
    if (myId || myName) {
      const isMyAnimePage = path.includes('/animelist') && (myName ? path.toLowerCase().includes(myName.toLowerCase()) : true);
      const isMyMangaPage = path.includes('/mangalist') && (myName ? path.toLowerCase().includes(myName.toLowerCase()) : true);
      if (!isMyAnimePage) {
        scheduleWorkerPrefetch('ANIME', myId, myName || undefined, 100);
      }
      if (!isMyMangaPage) {
        scheduleWorkerPrefetch('MANGA', myId, myName || undefined, 300);
      }
    }
  }
}

export function installPointerPrefetch(
  yielded: () => boolean,
  listen: (t: EventTarget, type: string, fn: any, opts?: any) => void = (t, type, fn, opts) =>
    t.addEventListener(type, fn, opts),
  timeout: FeatureContext['timeout'] | undefined = routeTimers?.timeout
) {
  const linkOf = (event: any) => event.target?.closest?.('a[href]') || null;
  const opts = { capture: true, passive: true };

  listen(
    doc,
    'pointerover',
    (event: any) => {
      if (routesDisposed) return;
      if (event.pointerType && event.pointerType !== 'mouse') return;
      const anchor = linkOf(event);
      dwellCancel?.();
      dwellCancel = null;
      if (anchor && timeout) {
        dwellCancel = timeout(() => {
          dwellCancel = null;
          if (!routesDisposed) prefetchFor(anchor, yielded);
        }, CFG.prefetchDwellMs);
      }
    },
    opts
  );
  listen(
    doc,
    'pointerout',
    () => {
      dwellCancel?.();
      dwellCancel = null;
    },
    opts
  );
  listen(
    doc,
    'pointerdown',
    (event: any) => {
      if (routesDisposed) return;
      const anchor = linkOf(event);
      if (anchor) prefetchFor(anchor, yielded);
    },
    opts
  );
}
