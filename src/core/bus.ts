import { unsafeWindow } from 'vite-plugin-monkey/dist/client';
import type {
  CleanupFn,
  CoreHooksApi,
  FastLoadCacheBridge,
  GqlFetchEvent,
  GqlFetchListener,
  RpcBlocker
} from '../types';

class ServiceRegistryImpl {
  private readonly services = new Map<string, unknown>();
  private readonly watchers = new Map<
    string,
    Set<{
      cb: (impl: any) => void | CleanupFn;
      cleanup: CleanupFn | null;
    }>
  >();

  provide<T>(name: string, impl: T): CleanupFn {
    this.services.set(name, impl);
    const subs = this.watchers.get(name);
    if (subs) {
      for (const entry of [...subs]) {
        this.runCleanup(entry);
        try {
          const res = entry.cb(impl);
          entry.cleanup = typeof res === 'function' ? res : null;
        } catch (e) {
          console.error(`[AL-Additions] Service watcher for "${name}" failed:`, e);
        }
      }
    }
    return () => {
      if (this.services.get(name) !== impl) return;
      this.services.delete(name);
      const currentSubs = this.watchers.get(name);
      if (currentSubs) {
        for (const entry of [...currentSubs]) {
          this.runCleanup(entry);
        }
      }
    };
  }

  get<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  onAvailable<T>(name: string, cb: (impl: T) => void | CleanupFn): CleanupFn {
    const entry = {
      cb,
      cleanup: null as CleanupFn | null
    };
    let subs = this.watchers.get(name);
    if (!subs) {
      subs = new Set();
      this.watchers.set(name, subs);
    }
    subs.add(entry);

    if (this.services.has(name)) {
      try {
        const res = cb(this.services.get(name) as T);
        entry.cleanup = typeof res === 'function' ? res : null;
      } catch (e) {
        console.error(`[AL-Additions] Service watcher for "${name}" failed:`, e);
      }
    }

    return () => {
      this.runCleanup(entry);
      subs?.delete(entry);
      if (subs && subs.size === 0) this.watchers.delete(name);
    };
  }

  private runCleanup(entry: { cleanup: CleanupFn | null }): void {
    if (!entry.cleanup) return;
    const fn = entry.cleanup;
    entry.cleanup = null;
    try {
      fn();
    } catch (e) {
      console.error('[AL-Additions] Service subscriber cleanup failed:', e);
    }
  }
}

class EventBusImpl {
  private readonly listeners = new Map<string, Set<(payload?: any) => void>>();

  emit(event: string, payload?: any): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (e) {
        console.error(`[AL-Additions] Event listener for "${event}" failed:`, e);
      }
    }
  }

  on(event: string, cb: (payload?: any) => void): CleanupFn {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set && set.size === 0) this.listeners.delete(event);
    };
  }
}

export const ServiceRegistry = new ServiceRegistryImpl();
export const EventBus = new EventBusImpl();

function resolvePageWindow(): Window {
  return (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window;
}

function isAniListGraphqlUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  if (rawUrl === '/graphql') return true;
  try {
    const u = new URL(rawUrl, location.href);
    return (
      u.pathname === '/graphql' &&
      (u.hostname === 'anilist.co' || u.hostname === 'graphql.anilist.co')
    );
  } catch {
    return false;
  }
}

export const CoreHooks: CoreHooksApi = (() => {
  let clearingDepth = 0;
  let cacheBridge: FastLoadCacheBridge | null = null;
  let fetchOwnerActive = false;
  const gqlListeners = new Set<GqlFetchListener>();
  const rpcBlockers = new Set<RpcBlocker>();
  const prefetchTokens = new Set<symbol>();

  let fallbackInstalled = false;
  let fallbackTargetWin: any = null;
  let origFetch: typeof fetch | null = null;
  let wrappedFetch: typeof fetch | null = null;

  function syncMirror(): void {
    try {
      const win = resolvePageWindow() as any;
      const snapshot = {
        sessionClearing: clearingDepth > 0,
        fetchOwner: fetchOwnerActive,
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
    if (fallbackInstalled || fetchOwnerActive || gqlListeners.size === 0) return;
    if (host !== 'anilist.co') return;

    const currentFetch = typeof win.fetch === 'function' ? win.fetch : typeof fetch === 'function' ? fetch : null;
    if (!currentFetch) return;

    origFetch = currentFetch;
    fallbackTargetWin = win;

    wrappedFetch = async function (this: any, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const baseFetch = origFetch!;
      const curHost = win?.location?.hostname || location.hostname;
      if (fetchOwnerActive || gqlListeners.size === 0 || curHost !== 'anilist.co') {
        return baseFetch.apply(this, arguments as any);
      }

      const rawUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : input && typeof (input as Request).url === 'string'
          ? (input as Request).url
          : '';
      const method = (
        init?.method ||
        (input && typeof (input as Request).method === 'string' ? (input as Request).method : 'GET')
      ).toUpperCase();

      if (method !== 'POST' || !isAniListGraphqlUrl(rawUrl)) {
        return baseFetch.apply(this, arguments as any);
      }

      let parsedBody: any = null;
      try {
        if (typeof init?.body === 'string') {
          parsedBody = JSON.parse(init.body);
        } else if (typeof Request !== 'undefined' && input instanceof Request) {
          const text = await input.clone().text();
          if (text) parsedBody = JSON.parse(text);
        }
      } catch {}

      const query = typeof parsedBody?.query === 'string' ? parsedBody.query : '';
      const variables =
        parsedBody?.variables && typeof parsedBody.variables === 'object' ? parsedBody.variables : {};
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

      const res = await baseFetch.apply(this, arguments as any);

      if (query && !fetchOwnerActive && gqlListeners.size > 0) {
        let data: any = undefined;
        try {
          const json = await res.clone().json();
          data = json?.data;
        } catch {}
        emitGqlFetch({
          phase: 'response',
          url: rawUrl,
          query,
          variables,
          operationName,
          status: res.status,
          ok: res.ok,
          data
        });
      }

      return res;
    } as typeof fetch;

    try {
      win.fetch = wrappedFetch;
      fallbackInstalled = true;
    } catch {
      origFetch = null;
      wrappedFetch = null;
      fallbackTargetWin = null;
    }
  }

  function uninstallFallbackFetch(): void {
    if (!fallbackInstalled) return;
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
    for (const cb of [...gqlListeners]) {
      try {
        cb(event);
      } catch (e) {
        console.error('[AL-Additions] onGqlFetch listener failed:', e);
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
    clearAuth(): void {
      try {
        cacheBridge?.clearAuth();
      } catch (e) {
        console.error('[AL-Additions] cacheBridge.clearAuth failed:', e);
      }
    },
    registerCacheBridge(bridge: FastLoadCacheBridge): CleanupFn {
      cacheBridge = bridge;
      syncMirror();
      return () => {
        if (cacheBridge === bridge) {
          cacheBridge = null;
          syncMirror();
        }
      };
    },
    getCacheBridge(): FastLoadCacheBridge | null {
      return cacheBridge;
    },
    markFetchOwner(active: boolean): void {
      fetchOwnerActive = !!active;
      if (fetchOwnerActive) {
        uninstallFallbackFetch();
      } else if (gqlListeners.size > 0) {
        installFallbackFetch();
      }
      syncMirror();
    },
    hasGqlFetchSubscribers(): boolean {
      return gqlListeners.size > 0;
    },
    emitGqlFetch,
    onGqlFetch(cb: GqlFetchListener): CleanupFn {
      gqlListeners.add(cb);
      installFallbackFetch();
      syncMirror();
      return () => {
        gqlListeners.delete(cb);
        if (gqlListeners.size === 0) uninstallFallbackFetch();
        syncMirror();
      };
    },
    blockRpc(fn: RpcBlocker): CleanupFn {
      rpcBlockers.add(fn);
      syncMirror();
      return () => {
        rpcBlockers.delete(fn);
        syncMirror();
      };
    },
    isRpcBlocked(query: string, variables: Record<string, any>): boolean {
      for (const fn of [...rpcBlockers]) {
        try {
          if (fn(query, variables)) return true;
        } catch (e) {
          console.error('[AL-Additions] RPC blocker failed:', e);
        }
      }
      return false;
    },
    setPrefetchPaused(paused: boolean): CleanupFn {
      if (!paused) return () => {};
      const token = Symbol('prefetch-pause');
      prefetchTokens.add(token);
      syncMirror();
      return () => {
        prefetchTokens.delete(token);
        syncMirror();
      };
    },
    isPrefetchSuppressed(): boolean {
      return prefetchTokens.size > 0;
    }
  };
})();
