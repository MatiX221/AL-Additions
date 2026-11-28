import { unsafeWindow } from 'vite-plugin-monkey/dist/client';
import type {
  CleanupFn,
  CoreHooksApi,
  EventArgs,
  EventMap,
  FastLoadCacheBridge,
  GqlFetchEvent,
  GqlFetchListener,
  RpcBlocker,
  ServiceMap
} from '../types';
import { createCoreLogger, store } from '../utils/helpers';

const coreLog = createCoreLogger('core');

interface ServiceRecord {
  impl: unknown;
  owner: symbol;
}

interface ServiceWatcherEntry {
  cb: (impl: any) => void | CleanupFn;
  cleanup: CleanupFn | null;
  active: boolean;
  gen: number;
}

class ServiceRegistryImpl {
  private readonly services = new Map<string, ServiceRecord>();
  private readonly watchers = new Map<string, Set<ServiceWatcherEntry>>();

  provide<K extends keyof ServiceMap>(name: K, impl: ServiceMap[K]): CleanupFn {
    const key = String(name);
    const owner = Symbol(key);
    const serviceRecord: ServiceRecord = { impl, owner };
    this.services.set(key, serviceRecord);
    const subs = this.watchers.get(key);
    if (subs) {
      for (const entry of [...subs]) {
        if (!entry.active) continue;
        this.runCleanup(entry);
        if (this.services.get(key) !== serviceRecord) break;
        if (!entry.active) continue;
        this.invokeWatcher(entry, impl, key);
        if (this.services.get(key) !== serviceRecord) break;
      }
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.services.get(key)?.owner !== owner) return;
      this.services.delete(key);
      const currentSubs = this.watchers.get(key);
      if (currentSubs) {
        for (const entry of [...currentSubs]) {
          if (!entry.active) continue;
          this.runCleanup(entry);
          if (this.services.has(key)) break;
        }
      }
    };
  }

  get<K extends keyof ServiceMap>(name: K): ServiceMap[K] | undefined {
    return this.services.get(String(name))?.impl as ServiceMap[K] | undefined;
  }

  onAvailable<K extends keyof ServiceMap>(
    name: K,
    cb: (impl: ServiceMap[K]) => void | CleanupFn
  ): CleanupFn {
    const key = String(name);
    const entry: ServiceWatcherEntry = {
      cb,
      cleanup: null,
      active: true,
      gen: 0
    };
    let subs = this.watchers.get(key);
    if (!subs) {
      subs = new Set();
      this.watchers.set(key, subs);
    }
    subs.add(entry);

    const current = this.services.get(key);
    if (current) {
      this.invokeWatcher(entry, current.impl as ServiceMap[K], key);
    }

    return () => {
      if (!entry.active) return;
      entry.active = false;
      this.runCleanup(entry);
      subs?.delete(entry);
      if (subs && subs.size === 0 && this.watchers.get(key) === subs) {
        this.watchers.delete(key);
      }
    };
  }

  private invokeWatcher(entry: ServiceWatcherEntry, impl: any, key: string): void {
    const myGen = ++entry.gen;
    try {
      const res = entry.cb(impl);
      if (typeof res === 'function') {
        if (entry.active && entry.gen === myGen) {
          this.runCleanup(entry);
          entry.cleanup = res;
        } else {
          try {
            res();
          } catch (e) {
            coreLog.error('Service subscriber cleanup failed:', e);
          }
        }
      } else if (entry.gen === myGen) {
        entry.cleanup = null;
      }
    } catch (e) {
      coreLog.error(`Service watcher for "${key}" failed:`, e);
    }
  }

  private runCleanup(entry: { cleanup: CleanupFn | null }): void {
    if (!entry.cleanup) return;
    const fn = entry.cleanup;
    entry.cleanup = null;
    try {
      fn();
    } catch (e) {
      coreLog.error('Service subscriber cleanup failed:', e);
    }
  }
}

interface EventListenerEntry {
  cb: (payload?: any) => void;
  active: boolean;
}

class EventBusImpl {
  private readonly listeners = new Map<string, Set<EventListenerEntry>>();
  private readonly retained = new Map<string, { payload: unknown; owner?: symbol }>();

  private dispatch(key: string, payload: unknown): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const entry of [...set]) {
      if (!entry.active) continue;
      try {
        entry.cb(payload);
      } catch (e) {
        coreLog.error(`Event listener for "${key}" failed:`, e);
      }
    }
  }

  emit<K extends keyof EventMap>(event: K, ...args: EventArgs<EventMap[K]>): void {
    const key = String(event);
    const [payload] = args;
    const existing = this.retained.get(key);
    if (existing) {
      existing.payload = payload;
    }
    this.dispatch(key, payload);
  }

  emitRetained<K extends keyof EventMap>(event: K, ...args: EventArgs<EventMap[K]>): void {
    const key = String(event);
    const [payload] = args;
    this.retained.set(key, { payload });
    this.dispatch(key, payload);
  }

  on<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): CleanupFn {
    const key = String(event);
    const entry: EventListenerEntry = { cb, active: true };
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(entry);
    return () => {
      if (!entry.active) return;
      entry.active = false;
      set?.delete(entry);
      if (set && set.size === 0 && this.listeners.get(key) === set) {
        this.listeners.delete(key);
      }
    };
  }

  onRetained<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): CleanupFn {
    const key = String(event);
    const unsub = this.on(event, cb);
    if (this.retained.has(key)) {
      const entry = this.retained.get(key)!;
      try {
        cb(entry.payload as EventMap[K]);
      } catch (e) {
        coreLog.error(`Retained event listener for "${key}" failed:`, e);
      }
    }
    return unsub;
  }

  /** @internal */
  emitRetainedOwned<K extends keyof EventMap>(owner: symbol, event: K, ...args: EventArgs<EventMap[K]>): void {
    const key = String(event);
    const [payload] = args;
    this.retained.set(key, { payload, owner });
    this.dispatch(key, payload);
  }

  /** @internal */
  clearRetainedByOwner(owner: symbol): void {
    for (const [key, entry] of [...this.retained]) {
      if (entry.owner === owner) {
        this.retained.delete(key);
      }
    }
  }
}

export const ServiceRegistry = new ServiceRegistryImpl();
export const EventBus = new EventBusImpl();

function isUrlLike(input: unknown, win: any): input is URL | { href: string } {
  if (!input || typeof input !== 'object') return false;
  if (typeof URL !== 'undefined' && input instanceof URL) return true;
  const WinURL = win?.URL;
  if (typeof WinURL === 'function' && input instanceof WinURL) return true;
  return typeof (input as any).href === 'string' && typeof (input as any).url !== 'string';
}

function isRequestLike(input: unknown, win: any): input is Request {
  if (!input || typeof input !== 'object') return false;
  if (typeof Request !== 'undefined' && input instanceof Request) return true;
  const WinRequest = win?.Request;
  return typeof WinRequest === 'function' && input instanceof WinRequest;
}

function resolvePageWindow(): Window {
  return (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window;
}

function isAniListGraphqlUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  if (rawUrl === '/graphql') return true;
  try {
    const u = new URL(rawUrl, location.href);
    return (
      u.origin === 'https://graphql.anilist.co' ||
      (u.hostname === 'anilist.co' && u.pathname.replace(/\/$/, '') === '/graphql')
    );
  } catch {
    return false;
  }
}

interface HookEntry<T> {
  cb: T;
  active: boolean;
}

function normalizeGqlQuery(query: unknown): string {
  return typeof query === 'string' ? query : String(query ?? '');
}

function normalizeGqlVariables(variables: unknown): Record<string, any> {
  return variables && typeof variables === 'object' && !Array.isArray(variables) ? variables : {};
}

function normalizeBearerHeader(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  return /^Bearer\s+\S/i.test(trimmed) ? trimmed : null;
}

export const CoreHooks: CoreHooksApi = (() => {
  let clearingDepth = 0;
  let cacheBridge: FastLoadCacheBridge | null = null;
  let cacheBridgeOwner: symbol | null = null;
  const fetchOwners = new Set<symbol>();
  const isFetchOwned = (): boolean => fetchOwners.size > 0;
  const gqlListeners = new Set<HookEntry<GqlFetchListener>>();
  const rpcBlockers = new Set<HookEntry<RpcBlocker>>();
  const prefetchTokens = new Set<symbol>();

  let fallbackInstalled = false;
  let fallbackTargetWin: any = null;
  let origFetch: typeof fetch | null = null;
  let wrappedFetch: typeof fetch | null = null;
  let deactivateFallback: (() => void) | null = null;

  function syncMirror(): void {
    try {
      const win = resolvePageWindow() as any;
      const snapshot = {
        sessionClearing: clearingDepth > 0,
        fetchOwner: isFetchOwned(),
        hasCacheBridge: !!cacheBridge,
        rpcBlockers: rpcBlockers.size,
        prefetchSuppressed: prefetchTokens.size > 0,
        gqlSubscribers: gqlListeners.size
      };
      const existing = win.__alaCoreMirror;
      if (existing && typeof existing === 'object' && !Object.isFrozen(existing)) {
        try {
          Object.assign(existing, snapshot);
          return;
        } catch {}
      }
      try {
        win.__alaCoreMirror = snapshot;
      } catch {}
    } catch {}
  }

  function installFallbackFetch(): void {
    const win = resolvePageWindow() as any;
    const host = win?.location?.hostname || location.hostname;
    if (fallbackInstalled || isFetchOwned() || gqlListeners.size === 0) return;
    if (host !== 'anilist.co') return;

    const currentFetch = typeof win.fetch === 'function' ? win.fetch : typeof fetch === 'function' ? fetch : null;
    if (!currentFetch) return;

    const localOrig = currentFetch;
    let instanceActive = true;
    const canIntercept = (): boolean => {
      const curHost = win?.location?.hostname || location.hostname;
      return instanceActive && !isFetchOwned() && gqlListeners.size > 0 && curHost === 'anilist.co';
    };

    origFetch = localOrig;
    fallbackTargetWin = win;
    deactivateFallback = () => {
      instanceActive = false;
    };

    wrappedFetch = async function (this: any, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const args = arguments;
      if (!canIntercept()) {
        return localOrig.apply(this ?? win, args as any);
      }

      const rawUrl =
        typeof input === 'string'
          ? input
          : isUrlLike(input, win)
          ? input.href
          : typeof (input as Request)?.url === 'string'
          ? (input as Request).url
          : '';
      const method = (
        init?.method ||
        (input && typeof (input as Request).method === 'string' ? (input as Request).method : 'GET')
      ).toUpperCase();

      if (method !== 'POST' || !isAniListGraphqlUrl(rawUrl)) {
        return localOrig.apply(this ?? win, args as any);
      }

      let parsedBody: any = null;
      try {
        if (typeof init?.body === 'string') {
          parsedBody = JSON.parse(init.body);
        } else if (
          isRequestLike(input, win) &&
          !(input as Request).bodyUsed &&
          typeof (input as Request).clone === 'function'
        ) {
          const text = await (input as Request).clone().text();
          if (text) parsedBody = JSON.parse(text);
        }
      } catch {}

      if (!canIntercept()) {
        return localOrig.apply(this ?? win, args as any);
      }

      const query = typeof parsedBody?.query === 'string' ? parsedBody.query : '';
      const variables = normalizeGqlVariables(parsedBody?.variables);
      const operationName =
        typeof parsedBody?.operationName === 'string' ? parsedBody.operationName : undefined;

      if (query) {
        emitGqlFetch({
          phase: 'request',
          url: rawUrl,
          query,
          variables,
          operationName
        });
      }

      const res = await localOrig.apply(this ?? win, args as any);

      if (query && canIntercept()) {
        let data: any = undefined;
        let errors: GqlFetchEvent['errors'] = undefined;
        if (res && !res.bodyUsed && typeof res.clone === 'function') {
          try {
            const json = await res.clone().json();
            data = json?.data;
            errors = Array.isArray(json?.errors) ? json.errors : undefined;
          } catch {}
        }
        if (canIntercept()) {
          emitGqlFetch({
            phase: 'response',
            url: rawUrl,
            query,
            variables,
            operationName,
            status: res.status,
            ok: res.ok,
            data,
            errors
          });
        }
      }

      return res;
    } as typeof fetch;

    try {
      win.fetch = wrappedFetch;
      fallbackInstalled = true;
    } catch {
      instanceActive = false;
      deactivateFallback = null;
      origFetch = null;
      wrappedFetch = null;
      fallbackTargetWin = null;
    }
  }

  function uninstallFallbackFetch(): void {
    if (!fallbackInstalled) return;
    deactivateFallback?.();
    deactivateFallback = null;
    try {
      if (fallbackTargetWin && fallbackTargetWin.fetch === wrappedFetch && origFetch) {
        fallbackTargetWin.fetch = origFetch;
      }
    } catch {}
    fallbackInstalled = false;
    origFetch = null;
    wrappedFetch = null;
    fallbackTargetWin = null;
  }

  function emitGqlFetch(event: GqlFetchEvent): void {
    if (!event || typeof event !== 'object') return;
    const query = normalizeGqlQuery(event.query);
    const variables = normalizeGqlVariables(event.variables);
    const normalizedEvent: GqlFetchEvent =
      query === event.query && variables === event.variables ? event : { ...event, query, variables };
    for (const entry of [...gqlListeners]) {
      if (!entry.active) continue;
      try {
        entry.cb(normalizedEvent);
      } catch (e) {
        coreLog.error('onGqlFetch listener failed:', e);
      }
    }
  }

  return {
    setSessionClearing(active: boolean): void {
      clearingDepth = Math.max(0, clearingDepth + (active ? 1 : -1));
      syncMirror();
    },
    isSessionClearing(): boolean {
      return clearingDepth > 0;
    },
    getAuthHeader(): string | null {
      return normalizeBearerHeader(store.get<unknown>('al_token_auth', null));
    },
    setAuthHeader(header: string | null): void {
      if (clearingDepth > 0) return;
      if (header == null) {
        store.del('al_token_auth');
        return;
      }
      const valid = normalizeBearerHeader(header);
      if (!valid) return;
      store.set('al_token_auth', valid);
    },
    clearAuth(): void {
      try {
        store.del('al_token_auth');
      } catch (e) {
        coreLog.error('Failed to clear stored auth header:', e);
      }
      try {
        cacheBridge?.clearAuth();
      } catch (e) {
        coreLog.error('cacheBridge.clearAuth failed:', e);
      }
    },
    registerCacheBridge(bridge: FastLoadCacheBridge): CleanupFn {
      let active = true;
      const owner = Symbol('cache-bridge');
      cacheBridge = bridge;
      cacheBridgeOwner = owner;
      syncMirror();
      return () => {
        if (!active) return;
        active = false;
        if (cacheBridgeOwner === owner) {
          cacheBridge = null;
          cacheBridgeOwner = null;
          syncMirror();
        }
      };
    },
    getCacheBridge(): FastLoadCacheBridge | null {
      return cacheBridge;
    },
    markFetchOwner(active: boolean): CleanupFn {
      if (!active) {
        if (!isFetchOwned() && gqlListeners.size > 0) {
          installFallbackFetch();
        }
        syncMirror();
        return () => {};
      }
      let released = false;
      const token = Symbol('fetch-owner');
      fetchOwners.add(token);
      uninstallFallbackFetch();
      syncMirror();
      return () => {
        if (released) return;
        released = true;
        fetchOwners.delete(token);
        if (!isFetchOwned() && gqlListeners.size > 0) {
          installFallbackFetch();
        }
        syncMirror();
      };
    },
    hasGqlFetchSubscribers(): boolean {
      return gqlListeners.size > 0;
    },
    emitGqlFetch,
    onGqlFetch(cb: GqlFetchListener): CleanupFn {
      const entry: HookEntry<GqlFetchListener> = { cb, active: true };
      gqlListeners.add(entry);
      installFallbackFetch();
      syncMirror();
      return () => {
        if (!entry.active) return;
        entry.active = false;
        gqlListeners.delete(entry);
        if (gqlListeners.size === 0) uninstallFallbackFetch();
        syncMirror();
      };
    },
    blockRpc(fn: RpcBlocker): CleanupFn {
      const entry: HookEntry<RpcBlocker> = { cb: fn, active: true };
      rpcBlockers.add(entry);
      syncMirror();
      return () => {
        if (!entry.active) return;
        entry.active = false;
        rpcBlockers.delete(entry);
        syncMirror();
      };
    },
    isRpcBlocked(query: string, variables: Record<string, any>): boolean {
      const normalizedQuery = normalizeGqlQuery(query);
      const normalizedVars = normalizeGqlVariables(variables);
      for (const entry of [...rpcBlockers]) {
        if (!entry.active) continue;
        try {
          if (entry.cb(normalizedQuery, normalizedVars)) return true;
        } catch (e) {
          coreLog.error('RPC blocker failed:', e);
        }
      }
      return false;
    },
    setPrefetchPaused(paused: boolean): CleanupFn {
      if (!paused) return () => {};
      let active = true;
      const token = Symbol('prefetch-pause');
      prefetchTokens.add(token);
      syncMirror();
      return () => {
        if (!active) return;
        active = false;
        prefetchTokens.delete(token);
        syncMirror();
      };
    },
    isPrefetchSuppressed(): boolean {
      return prefetchTokens.size > 0;
    }
  };
})();
