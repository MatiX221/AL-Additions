import { GM_xmlhttpRequest } from 'vite-plugin-monkey/dist/client';
import { Settings } from '../settings/settings';
import {
  SETTING_PREFIX,
  type AccountProvider,
  type AniListClient,
  type AniListSession,
  type CleanupFn,
  type CoreHooksApi,
  type FeatureContext,
  type FeatureLayer,
  type FeatureMeta,
  type HttpRequestOptions,
  type ModuleDef,
  type ModuleDisableReason,
  type ModuleHost,
  type ModuleLayer,
  type ModuleMeta,
  type ModuleStatus,
  type MountSpec,
  type RouteContext
} from '../types';
import { isDebug, logDebug, persistent, registerDebugChannel, store } from '../utils/helpers';
import {
  clearAccountSecrets,
  getAccountProvider,
  registerAccountProvider
} from './accounts';
import { CoreHooks, EventBus, ServiceRegistry } from './bus';
import { registerMenuCommand } from './menu';
import { Core } from './observer';
import { addStyle } from './styles';
import { showToast, toastError, toastSuccess } from './toast';

export const modules: ModuleDef[] = [];

const LAYER_ORDER: Record<ModuleLayer, number> = {
  intercept: 0,
  preload: 1,
  service: 2,
  feature: 3,
  shell: 4
};

const ID_RE = /^[a-z][A-Za-z0-9]*$/;

interface CoreServices {
  api: AniListClient;
  session: AniListSession;
}

let configuredServices: CoreServices | null = null;

export function configureCoreServices(services: CoreServices): void {
  configuredServices = services;
}

function getCoreApi(): AniListClient {
  if (!configuredServices) {
    throw new Error('[AL-Additions] Core services not configured before module access.');
  }
  return configuredServices.api;
}

function getCoreSession(): AniListSession {
  if (!configuredServices) {
    throw new Error('[AL-Additions] Core services not configured before module access.');
  }
  return configuredServices.session;
}

interface ModuleRecord {
  id: string;
  setting: string | null;
  hosts: string[];
  layer: ModuleLayer;
  early: boolean;
  requiresReload: boolean;
  dependsOn: string[];
  after: string[];
  debugChannel?: string;
  standalone?: ModuleMeta['standalone'];
  migrate?: () => void;
  setup: (ctx: FeatureContext) => void | Promise<void>;
  legacyInit?: () => void | Promise<void>;
  invalidId: boolean;
  idCollision: boolean;
  standalonePaused: boolean;
  runtimeError?: string;
  booted: boolean;
  bootSeq: number;
  cleanups: CleanupFn[];
  abortController: AbortController | null;
}

const records: ModuleRecord[] = [];
const recordsById = new Map<string, ModuleRecord>();
const invalidIds = new Map<string, ModuleStatus>();
const liveStatuses = new Map<string, ModuleStatus>();
const statusListeners = new Set<(id: string, status: ModuleStatus) => void>();

function currentHost(): string {
  return location.hostname;
}

function resolveHostMatches(hosts: string[], host: string): boolean {
  return hosts.includes('*') || hosts.includes(host);
}

function emitStatusChange(id: string, status: ModuleStatus): void {
  const prev = liveStatuses.get(id);
  const changed =
    !prev ||
    prev.active !== status.active ||
    prev.reason !== status.reason ||
    prev.error !== status.error ||
    JSON.stringify(prev.missingDeps || []) !== JSON.stringify(status.missingDeps || []) ||
    JSON.stringify(prev.disabledDeps || []) !== JSON.stringify(status.disabledDeps || []);
  liveStatuses.set(id, status);
  if (changed) {
    for (const cb of [...statusListeners]) {
      try {
        cb(id, status);
      } catch (e) {
        console.error('[AL-Additions] Module status listener failed:', e);
      }
    }
  }
}

interface ResolvedGraph {
  statuses: Record<string, ModuleStatus>;
  ordered: ModuleRecord[];
}

function resolveAllStates(stagedEnabled?: Record<string, boolean>): ResolvedGraph {
  const host = currentHost();
  const statuses: Record<string, ModuleStatus> = {};
  const candidates = new Map<string, ModuleRecord>();

  for (const [badId, status] of invalidIds) {
    statuses[badId] = status;
  }

  for (const rec of records) {
    if (rec.invalidId) {
      statuses[rec.id] = { active: false, reason: 'invalid-id' };
      continue;
    }
    if (rec.idCollision) {
      statuses[rec.id] = { active: false, reason: 'id-collision' };
      continue;
    }
    if (!resolveHostMatches(rec.hosts, host)) {
      statuses[rec.id] = { active: false, reason: 'host-mismatch' };
      continue;
    }
    const enabled =
      stagedEnabled && rec.id in stagedEnabled
        ? !!stagedEnabled[rec.id]
        : rec.setting
        ? !!Settings.get(rec.setting)
        : true;
    if (!enabled) {
      statuses[rec.id] = { active: false, reason: 'disabled' };
      continue;
    }
    if (rec.standalonePaused) {
      statuses[rec.id] = { active: false, reason: 'standalone-paused' };
      continue;
    }
    if (!stagedEnabled && rec.runtimeError) {
      statuses[rec.id] = { active: false, reason: 'error', error: rec.runtimeError };
      continue;
    }
    candidates.set(rec.id, rec);
  }

  // Iteratively prune hard dependency failures.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, rec] of [...candidates]) {
      const missingDeps: string[] = [];
      const disabledDeps: string[] = [];
      let layerConflict = false;
      let cycleDep = false;

      for (const depId of rec.dependsOn) {
        const depRec = recordsById.get(depId);
        if (!depRec) {
          missingDeps.push(depId);
          continue;
        }
        if (LAYER_ORDER[depRec.layer] > LAYER_ORDER[rec.layer]) {
          layerConflict = true;
          continue;
        }
        if (!candidates.has(depId)) {
          const depStatus = statuses[depId];
          if (depStatus?.reason === 'disabled' || depStatus?.reason === 'dep-off') {
            disabledDeps.push(depId);
          } else if (depStatus?.reason === 'cycle') {
            cycleDep = true;
          } else {
            missingDeps.push(depId);
          }
        }
      }

      let reason: ModuleDisableReason | null = null;
      if (layerConflict) reason = 'layer-conflict';
      else if (missingDeps.length) reason = 'dep-unavailable';
      else if (disabledDeps.length) reason = 'dep-off';
      else if (cycleDep) reason = 'cycle';

      if (reason) {
        statuses[id] = {
          active: false,
          reason,
          ...(missingDeps.length ? { missingDeps } : {}),
          ...(disabledDeps.length ? { disabledDeps } : {})
        };
        candidates.delete(id);
        changed = true;
      }
    }
  }

  // Kahn's algorithm across hard dependsOn to catch cycles + transitive dependents.
  const hardIn = new Map<string, number>();
  const hardOut = new Map<string, string[]>();
  for (const id of candidates.keys()) {
    hardIn.set(id, 0);
    hardOut.set(id, []);
  }
  for (const [id, rec] of candidates) {
    for (const depId of new Set(rec.dependsOn)) {
      if (candidates.has(depId)) {
        hardIn.set(id, (hardIn.get(id) || 0) + 1);
        hardOut.get(depId)!.push(id);
      }
    }
  }
  const kahnQueue: string[] = [];
  for (const [id, deg] of hardIn) if (deg === 0) kahnQueue.push(id);
  const acyclic = new Set<string>();
  while (kahnQueue.length) {
    const id = kahnQueue.shift()!;
    acyclic.add(id);
    for (const next of hardOut.get(id) || []) {
      const deg = (hardIn.get(next) || 0) - 1;
      hardIn.set(next, deg);
      if (deg === 0) kahnQueue.push(next);
    }
  }
  for (const id of [...candidates.keys()]) {
    if (!acyclic.has(id)) {
      statuses[id] = { active: false, reason: 'cycle' };
      candidates.delete(id);
    }
  }

  const ordered: ModuleRecord[] = [];
  const layers: ModuleLayer[] = ['intercept', 'preload', 'service', 'feature', 'shell'];

  const hasHardPath = (startId: string, targetId: string, seen = new Set<string>()): boolean => {
    if (startId === targetId) return true;
    if (seen.has(startId)) return false;
    seen.add(startId);
    const mod = candidates.get(startId);
    if (!mod) return false;
    return mod.dependsOn.some((dep) => hasHardPath(dep, targetId, seen));
  };

  for (const layer of layers) {
    const layerMods = [...candidates.values()].filter((m) => m.layer === layer);
    if (!layerMods.length) continue;

    const layerSet = new Set(layerMods.map((m) => m.id));
    const hardDeps = new Map<string, Set<string>>();
    const allDeps = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();

    for (const m of layerMods) {
      hardDeps.set(m.id, new Set());
      allDeps.set(m.id, new Set());
      dependents.set(m.id, new Set());
    }

    for (const m of layerMods) {
      for (const depId of m.dependsOn) {
        if (layerSet.has(depId) && depId !== m.id) {
          hardDeps.get(m.id)!.add(depId);
          allDeps.get(m.id)!.add(depId);
          dependents.get(depId)!.add(m.id);
        }
      }
    }

    for (const m of layerMods) {
      for (const afterId of m.after) {
        if (!layerSet.has(afterId) || afterId === m.id) continue;
        if (hasHardPath(afterId, m.id)) continue;
        allDeps.get(m.id)!.add(afterId);
        dependents.get(afterId)!.add(m.id);
      }
    }

    const remaining = new Set(layerSet);
    while (remaining.size) {
      const ready = [...remaining]
        .filter((id) => allDeps.get(id)!.size === 0)
        .sort((a, b) => a.localeCompare(b));

      let pick: string;
      if (ready.length) {
        pick = ready[0];
      } else {
        const hardReady = [...remaining]
          .filter((id) => hardDeps.get(id)!.size === 0)
          .sort((a, b) => a.localeCompare(b));
        pick = hardReady[0] || [...remaining].sort((a, b) => a.localeCompare(b))[0];
      }

      remaining.delete(pick);
      const rec = candidates.get(pick)!;
      ordered.push(rec);
      statuses[pick] = { active: true };
      for (const next of dependents.get(pick) || []) {
        hardDeps.get(next)?.delete(pick);
        allDeps.get(next)?.delete(pick);
      }
    }
  }

  return { statuses, ordered };
}

function syncAllLiveStatuses(statuses: Record<string, ModuleStatus>): void {
  for (const [id, st] of Object.entries(statuses)) {
    emitStatusChange(id, st);
  }
}

function runCleanupsReverse(id: string, cleanups: CleanupFn[]): void {
  for (let i = cleanups.length - 1; i >= 0; i--) {
    try {
      cleanups[i]();
    } catch (e) {
      console.error(`[AL-Additions] Module "${id}" failed during cleanup:`, e);
    }
  }
  cleanups.length = 0;
}

function createContextForRecord(rec: ModuleRecord, cleanups: CleanupFn[], ac: AbortController): FeatureContext {
  let disposed = false;
  const activeRequests = new Set<{ abort?: () => void; reject?: (e: Error) => void }>();

  const track = <T extends CleanupFn>(fn: T): T => {
    if (disposed) {
      try {
        fn();
      } catch {}
      return fn;
    }
    cleanups.push(fn);
    return fn;
  };

  track(() => {
    disposed = true;
    ac.abort();
    for (const req of [...activeRequests]) {
      try {
        req.abort?.();
      } catch {}
      try {
        req.reject?.(new Error('Request aborted'));
      } catch {}
    }
    activeRequests.clear();
  });

  const storagePrefix = `ala_mod_${rec.id}_`;

  const addMount = (spec: MountSpec, pushCleanup: (fn: CleanupFn) => void): CleanupFn => {
    let mountedEl: HTMLElement | null = null;
    let mountDisposed = false;
    let ownDisposer: CleanupFn | null = null;

    const tryMount = () => {
      if (mountDisposed || disposed) return;
      if (spec.match && !spec.match()) {
        if (mountedEl) {
          mountedEl.remove();
          mountedEl = null;
        }
        return;
      }
      if (mountedEl?.isConnected) return;
      if (spec.id) {
        const existing = document.getElementById(spec.id);
        if (existing?.isConnected) {
          mountedEl = existing;
          return;
        }
      }
      const anchor = typeof spec.anchor === 'string' ? document.querySelector(spec.anchor) : spec.anchor();
      if (!anchor) return;
      const el = spec.create();
      if (spec.id && !el.id) el.id = spec.id;
      anchor.insertAdjacentElement(spec.position ?? 'afterend', el);
      mountedEl = el;
      if (spec.ownUi && !ownDisposer) {
        const sel = el.id ? `#${el.id}` : spec.id ? `#${spec.id}` : '';
        if (sel) ownDisposer = Core.registerOwnUi(sel);
      }
    };

    const unsubReady = Core.ready(tryMount);
    const unsubNav = Core.onNavigate(tryMount);
    const unsubBody = Core.onBodyMutation(tryMount);

    const disposeMount = () => {
      if (mountDisposed) return;
      mountDisposed = true;
      unsubReady();
      unsubNav();
      unsubBody();
      ownDisposer?.();
      ownDisposer = null;
      mountedEl?.remove();
      mountedEl = null;
    };
    pushCleanup(disposeMount);
    return disposeMount;
  };

  const makeScopedHelpers = (push: (fn: CleanupFn) => void, signal: AbortSignal) => ({
    listen: (
      target: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ): CleanupFn => {
      if (signal.aborted) return () => {};
      target.addEventListener(type, listener, options);
      const cleanup = () => target.removeEventListener(type, listener, options);
      push(cleanup);
      return cleanup;
    },
    interval: (fn: () => void, ms: number): CleanupFn => {
      if (signal.aborted) return () => {};
      const id = setInterval(fn, ms);
      const cleanup = () => clearInterval(id);
      push(cleanup);
      return cleanup;
    },
    timeout: (fn: () => void, ms: number): CleanupFn => {
      if (signal.aborted) return () => {};
      const id = setTimeout(fn, ms);
      const cleanup = () => clearTimeout(id);
      push(cleanup);
      return cleanup;
    },
    mount: (spec: MountSpec): CleanupFn => addMount(spec, push),
    waitForSelector: <T extends HTMLElement = HTMLElement>(selector: string, timeoutMs = 8000): Promise<T | null> =>
      Core.waitForSelector<T>(selector, timeoutMs, signal)
  });

  const rootScoped = makeScopedHelpers(track, ac.signal);

  const onRoute = (
    matchOrHandler:
      | RegExp
      | ((url: URL) => boolean)
      | ((rc: RouteContext) => void | Promise<void> | CleanupFn),
    maybeHandler?: (rc: RouteContext) => void | Promise<void> | CleanupFn
  ): CleanupFn => {
    const matcher = typeof maybeHandler === 'function' ? (matchOrHandler as RegExp | ((url: URL) => boolean)) : null;
    const handler = (maybeHandler ?? matchOrHandler) as (rc: RouteContext) => void | Promise<void> | CleanupFn;

    let routeCleanups: CleanupFn[] = [];
    let routeAc: AbortController | null = null;
    let routeSubDisposed = false;

    const teardownRoute = () => {
      routeAc?.abort();
      routeAc = null;
      runCleanupsReverse(rec.id, routeCleanups);
    };

    const evaluate = () => {
      if (routeSubDisposed || disposed) return;
      teardownRoute();

      let url: URL;
      try {
        url = new URL(location.href);
      } catch {
        url = new URL('https://anilist.co/');
      }

      let matchArr: RegExpMatchArray | null = null;
      if (matcher instanceof RegExp) {
        matchArr = url.pathname.match(matcher);
        if (!matchArr) return;
      } else if (typeof matcher === 'function') {
        if (!matcher(url)) return;
      }

      const localAc = new AbortController();
      routeAc = localAc;
      const localCleanups: CleanupFn[] = [];
      routeCleanups = localCleanups;
      const localScoped = makeScopedHelpers((fn) => localCleanups.push(fn), localAc.signal);

      const rc: RouteContext = {
        url,
        pathname: url.pathname,
        match: matchArr,
        signal: localAc.signal,
        onCleanup: (fn) => {
          if (localAc.signal.aborted) {
            try {
              fn();
            } catch {}
          } else {
            localCleanups.push(fn);
          }
        },
        ...localScoped
      };

      try {
        const res = handler(rc);
        if (typeof res === 'function') {
          rc.onCleanup(res);
        } else if (res && typeof (res as Promise<any>).then === 'function') {
          Promise.resolve(res).then(
            (maybeCleanup) => {
              if (typeof maybeCleanup === 'function') rc.onCleanup(maybeCleanup);
            },
            (err) => {
              if (!localAc.signal.aborted) {
                console.error(`[AL-Additions] Module "${rec.id}" route handler failed:`, err);
              }
            }
          );
        }
      } catch (err) {
        console.error(`[AL-Additions] Module "${rec.id}" route handler failed:`, err);
      }
    };

    evaluate();
    const unsubNav = Core.onNavigate(evaluate);

    const disposeRouteWatcher = () => {
      if (routeSubDisposed) return;
      routeSubDisposed = true;
      unsubNav();
      teardownRoute();
    };
    return track(disposeRouteWatcher);
  };

  const httpRequest = (url: string, opts: HttpRequestOptions = {}): Promise<any> => {
    if (disposed || ac.signal.aborted) {
      return Promise.reject(new Error('Request aborted'));
    }
    return new Promise((resolve, reject) => {
      const entry: { abort?: () => void; reject?: (e: Error) => void } = { reject };
      activeRequests.add(entry);
      const settle = (fn: () => void) => {
        if (!activeRequests.has(entry)) return;
        activeRequests.delete(entry);
        fn();
      };
      const g = globalThis as any;
      const xhr =
        (Object.prototype.hasOwnProperty.call(g, 'GM_xmlhttpRequest') && typeof g.GM_xmlhttpRequest === 'function'
          ? g.GM_xmlhttpRequest
          : GM_xmlhttpRequest) as typeof GM_xmlhttpRequest;
      const handle = xhr({
        method: 'GET',
        timeout: 15000,
        ...(opts as any),
        url,
        onload: (res: any) => settle(() => resolve(res)),
        onerror: () => settle(() => reject(new Error('Network error'))),
        ontimeout: () => settle(() => reject(new Error('Timeout'))),
        onabort: () => settle(() => reject(new Error('Request aborted')))
      });
      entry.abort = () => {
        try {
          handle?.abort?.();
        } catch {}
      };
    });
  };

  const trackedHooks: CoreHooksApi = {
    setSessionClearing: (active) => CoreHooks.setSessionClearing(active),
    isSessionClearing: () => CoreHooks.isSessionClearing(),
    clearAuth: () => CoreHooks.clearAuth(),
    registerCacheBridge: (bridge) => track(CoreHooks.registerCacheBridge(bridge)),
    getCacheBridge: () => CoreHooks.getCacheBridge(),
    markFetchOwner: (active) => CoreHooks.markFetchOwner(active),
    hasGqlFetchSubscribers: () => CoreHooks.hasGqlFetchSubscribers(),
    emitGqlFetch: (event) => CoreHooks.emitGqlFetch(event),
    onGqlFetch: (cb) => track(CoreHooks.onGqlFetch(cb)),
    blockRpc: (fn) => track(CoreHooks.blockRpc(fn)),
    isRpcBlocked: (q, v) => CoreHooks.isRpcBlocked(q, v),
    setPrefetchPaused: (paused) => track(CoreHooks.setPrefetchPaused(paused)),
    isPrefetchSuppressed: () => CoreHooks.isPrefetchSuppressed()
  };

  const debugChannel = rec.debugChannel || rec.id;

  const ctx: FeatureContext = {
    id: rec.id,
    get: (key) => Settings.get(key),
    set: (key, val) => Settings.set(key, val),
    storage: {
      get: <T>(k: string, d?: T) => store.get<T>(`${storagePrefix}${k}`, d),
      set: <T>(k: string, v: T) => store.set(`${storagePrefix}${k}`, v),
      del: (k: string) => store.del(`${storagePrefix}${k}`),
      watch: (k, cb) =>
        track(store.watch(`${storagePrefix}${k}`, (_fullKey, oldV, newV, remote) => cb(k, oldV, newV, remote))),
      clear: () => {
        for (const k of store.list()) {
          if (k.startsWith(storagePrefix)) store.del(k);
        }
      }
    },
    persistent: (key, prune) => persistent(key, prune),
    ready: (cb) => track(Core.ready(cb)),
    onNav: (cb) => track(Core.onNavigate(cb)),
    onBodyMutation: (cb) => track(Core.onBodyMutation(cb)),
    onRoute,
    mount: rootScoped.mount,
    addStyle: (id, css) => track(addStyle(id, css)),
    listen: rootScoped.listen,
    interval: rootScoped.interval,
    timeout: rootScoped.timeout,
    trackEl: <T extends Element>(el: T): T => {
      track(() => el.remove());
      return el;
    },
    waitForSelector: rootScoped.waitForSelector,
    silently: (fn) => Core.silently(fn),
    ownUi: (selector) => track(Core.registerOwnUi(selector)),
    onCleanup: (fn) => {
      track(fn);
    },
    http: {
      request: httpRequest,
      text: async (url: string, opts?: HttpRequestOptions) => {
        const r = await httpRequest(url, opts);
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
        return r.responseText || '';
      },
      json: async <T = any>(url: string, opts?: HttpRequestOptions) => {
        const r = await httpRequest(url, opts);
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
        return JSON.parse(r.responseText || '') as T;
      }
    },
    get api(): AniListClient {
      return getCoreApi();
    },
    get session(): AniListSession {
      return getCoreSession();
    },
    accounts: {
      get: (id: string): AccountProvider | undefined => getAccountProvider(id),
      isConnected: (id: string): boolean => !!getAccountProvider(id)?.isConnected(),
      connect: (id: string) => getAccountProvider(id)?.connect(),
      disconnect: (id: string) => getAccountProvider(id)?.disconnect(),
      clearSecrets: (providerId?: string) => clearAccountSecrets(providerId)
    },
    toast: {
      show: showToast,
      success: toastSuccess,
      error: toastError
    },
    menuCommand: (label, onClick) => track(registerMenuCommand(label, onClick)),
    services: {
      provide: (localName, impl) => track(ServiceRegistry.provide(`${rec.id}:${localName}`, impl)),
      get: (fullName) => ServiceRegistry.get(fullName),
      onAvailable: (fullName, cb) => track(ServiceRegistry.onAvailable(fullName, cb))
    },
    events: {
      emit: (event, payload) => EventBus.emit(event, payload),
      on: (event, cb) => track(EventBus.on(event, cb))
    },
    hooks: trackedHooks,
    debug: {
      enabled: () => isDebug(debugChannel),
      log: (...args: any[]) => logDebug(`[${debugChannel.toUpperCase()}]`, ...args)
    },
    setStandalonePaused: (paused: boolean) => {
      rec.standalonePaused = !!paused;
      const graph = resolveAllStates();
      syncAllLiveStatuses(graph.statuses);
    }
  };

  return ctx;
}

function disposeRecord(rec: ModuleRecord, resetStandalone = true): void {
  rec.bootSeq++;
  const hadCleanups = rec.cleanups.length > 0;
  if (rec.booted || hadCleanups) {
    runCleanupsReverse(rec.id, rec.cleanups);
  }
  rec.abortController = null;
  rec.booted = false;
  rec.runtimeError = undefined;
  if (resetStandalone) rec.standalonePaused = false;
}

function bootRecord(rec: ModuleRecord): Promise<void> {
  if (rec.booted) return Promise.resolve();
  const seq = ++rec.bootSeq;
  rec.runtimeError = undefined;
  const ac = new AbortController();
  const cleanups: CleanupFn[] = [];
  rec.cleanups = cleanups;
  rec.abortController = ac;
  rec.booted = true;

  const ctx = createContextForRecord(rec, cleanups, ac);
  logDebug('[CORE]', `Initializing module "${rec.id}" (layer=${rec.layer}, early=${rec.early})`);

  const handleFailure = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AL-Additions] Module "${rec.id}" failed during setup:`, err);
    runCleanupsReverse(rec.id, cleanups);
    if (rec.bootSeq === seq) {
      rec.booted = false;
      rec.abortController = null;
      rec.runtimeError = msg;
      const graph = resolveAllStates();
      syncAllLiveStatuses(graph.statuses);
    }
  };

  try {
    const res = rec.setup(ctx);
    if (res && typeof (res as Promise<void>).then === 'function') {
      return Promise.resolve(res).then(
        () => {
          if (rec.bootSeq !== seq) {
            runCleanupsReverse(rec.id, cleanups);
            return;
          }
          if (rec.standalonePaused) {
            rec.booted = false;
          }
        },
        (err) => {
          handleFailure(err);
        }
      );
    }
    if (rec.standalonePaused) {
      rec.booted = false;
    }
    return Promise.resolve();
  } catch (err) {
    handleFailure(err);
    return Promise.resolve();
  }
}

function registerRecord(rec: ModuleRecord): void {
  records.push(rec);
  recordsById.set(rec.id, rec);
  modules.push({
    name: rec.id,
    setting: rec.setting,
    init: rec.legacyInit ?? (() => bootRecord(rec)),
    hosts: rec.hosts,
    early: rec.early,
    layer: rec.layer,
    dependsOn: rec.dependsOn,
    after: rec.after
  });
}

export function defineModule(meta: ModuleMeta): void {
  if (!ID_RE.test(meta.id)) {
    console.error(`[AL-Additions] Invalid module ID "${meta.id}". Must match ${ID_RE}.`);
    invalidIds.set(meta.id, { active: false, reason: 'invalid-id' });
    emitStatusChange(meta.id, { active: false, reason: 'invalid-id' });
    return;
  }

  const existing = recordsById.get(meta.id);
  if (existing) {
    console.error(`[AL-Additions] Duplicate module ID "${meta.id}" ignored.`);
    existing.idCollision = true;
    emitStatusChange(meta.id, { active: false, reason: 'id-collision' });
    return;
  }

  const layer: FeatureLayer = meta.layer ?? 'feature';
  const hosts = meta.hosts?.length ? meta.hosts.slice() : ['anilist.co'];
  const dependsOn = (meta.dependsOn || []).slice();
  const after = (meta.after || []).slice();

  Settings.register({
    id: meta.id,
    key: meta.key,
    section: meta.section,
    title: meta.title,
    help: meta.help,
    type: 'toggle',
    def: false,
    legacy: meta.legacy,
    options: meta.options,
    hosts,
    layer,
    requiresReload: meta.requiresReload,
    dependsOn,
    after,
    accounts: meta.accounts,
    debug: meta.debug,
    standalone: meta.standalone,
    backupTools: meta.backupTools
  });

  if (meta.debug) {
    const channel = meta.debug.channel || meta.id;
    registerDebugChannel(channel, `${SETTING_PREFIX}${meta.debug.key}`, false, meta.debug.pattern);
  }

  registerRecord({
    id: meta.id,
    setting: meta.key,
    hosts,
    layer,
    early: layer === 'intercept' || layer === 'preload',
    requiresReload: !!meta.requiresReload,
    dependsOn,
    after,
    debugChannel: meta.debug?.channel || meta.id,
    standalone: meta.standalone,
    migrate: meta.migrate,
    setup: meta.setup,
    invalidId: false,
    idCollision: false,
    standalonePaused: false,
    booted: false,
    bootSeq: 0,
    cleanups: [],
    abortController: null
  });
}

export function registerShellModule(
  name: string,
  init: () => void | Promise<void>,
  hosts: string[] = ['anilist.co']
): void {
  if (!ID_RE.test(name)) {
    console.error(`[AL-Additions] Invalid shell module ID "${name}". Must match ${ID_RE}.`);
    invalidIds.set(name, { active: false, reason: 'invalid-id' });
    emitStatusChange(name, { active: false, reason: 'invalid-id' });
    return;
  }

  const existing = recordsById.get(name);
  if (existing) {
    console.error(`[AL-Additions] Duplicate module ID "${name}" ignored.`);
    existing.idCollision = true;
    emitStatusChange(name, { active: false, reason: 'id-collision' });
    return;
  }

  registerRecord({
    id: name,
    setting: null,
    hosts: hosts.slice(),
    layer: 'shell',
    early: false,
    requiresReload: true,
    dependsOn: [],
    after: [],
    setup: () => init(),
    legacyInit: init,
    invalidId: false,
    idCollision: false,
    standalonePaused: false,
    booted: false,
    bootSeq: 0,
    cleanups: [],
    abortController: null
  });
}

/**
 * Temporary backwards-compatibility wrapper while remaining modules migrate to `defineModule`.
 * @deprecated Remove after Phase 4 module decoupling finishes.
 */
export const defineFeature = (meta: FeatureMeta, init: () => void | Promise<void>): void => {
  if (!ID_RE.test(meta.id)) {
    console.error(`[AL-Additions] Invalid module ID "${meta.id}". Must match ${ID_RE}.`);
    invalidIds.set(meta.id, { active: false, reason: 'invalid-id' });
    emitStatusChange(meta.id, { active: false, reason: 'invalid-id' });
    return;
  }

  const existing = recordsById.get(meta.id);
  if (existing) {
    console.error(`[AL-Additions] Duplicate module ID "${meta.id}" ignored.`);
    existing.idCollision = true;
    emitStatusChange(meta.id, { active: false, reason: 'id-collision' });
    return;
  }

  const layer: FeatureLayer = meta.layer ?? (meta.early ? 'intercept' : 'feature');
  const hosts = meta.hosts?.length ? meta.hosts.slice() : ['anilist.co'];
  const dependsOn = (meta.dependsOn || []).slice();
  const after = (meta.after || []).slice();

  Settings.register({
    ...meta,
    hosts,
    layer,
    dependsOn,
    after
  });

  registerRecord({
    id: meta.id,
    setting: meta.alwaysRun ? null : meta.key,
    hosts,
    layer,
    early: layer === 'intercept' || layer === 'preload',
    requiresReload: meta.requiresReload ?? true,
    dependsOn,
    after,
    setup: () => init(),
    legacyInit: init,
    invalidId: false,
    idCollision: false,
    standalonePaused: false,
    booted: false,
    bootSeq: 0,
    cleanups: [],
    abortController: null
  });
};

export function runMigrations(): void {
  Settings.migrate();

  const layers: ModuleLayer[] = ['intercept', 'preload', 'service', 'feature', 'shell'];
  for (const layer of layers) {
    const layerRecs = records
      .filter((r) => !r.invalidId && !r.idCollision && r.layer === layer)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const rec of layerRecs) {
      if (!rec.migrate) continue;
      try {
        rec.migrate();
      } catch (e) {
        console.error(`[AL-Additions] Module "${rec.id}" failed during migrate:`, e);
      }
    }
  }
}

export function startModules(early: boolean): void {
  const graph = resolveAllStates();
  syncAllLiveStatuses(graph.statuses);

  for (const rec of graph.ordered) {
    if (rec.early !== early) continue;
    // Re-check hard dependencies in case an earlier-booted dependency threw synchronously.
    const depFailed = rec.dependsOn.some((depId) => {
      const dep = recordsById.get(depId);
      return !dep || !!dep.runtimeError || dep.standalonePaused || !dep.booted;
    });
    if (depFailed) {
      emitStatusChange(rec.id, { active: false, reason: 'dep-unavailable' });
      continue;
    }
    void bootRecord(rec);
  }
}

export function disposeFeature(id: string): void {
  const rec = recordsById.get(id);
  if (!rec) return;
  disposeRecord(rec, true);
  const graph = resolveAllStates();
  syncAllLiveStatuses(graph.statuses);
}

export function reloadFeature(id: string): void {
  createModuleHost().reload([id]);
}

export async function bootModuleForTest(id: string): Promise<void> {
  const rec = recordsById.get(id);
  if (!rec) throw new Error(`Unknown module: ${id}`);
  if (rec.invalidId) {
    emitStatusChange(id, { active: false, reason: 'invalid-id' });
    return;
  }
  if (rec.idCollision) {
    emitStatusChange(id, { active: false, reason: 'id-collision' });
    return;
  }
  disposeRecord(rec, true);
  await bootRecord(rec);
  if (!rec.standalonePaused && !rec.runtimeError) {
    emitStatusChange(id, { active: true });
  }
}

export function createModuleHost(): ModuleHost {
  return {
    reload(ids: string[]): void {
      const targetSet = new Set(ids);
      const graph = resolveAllStates();
      const nextActiveIds = new Set(graph.ordered.map((r) => r.id));

      // Include any booted module that is no longer active or transitively depends on a target/stopped module.
      const toStop = new Set<string>();
      for (const rec of records) {
        if (rec.booted && (targetSet.has(rec.id) || !nextActiveIds.has(rec.id))) {
          toStop.add(rec.id);
        }
      }
      let added = true;
      while (added) {
        added = false;
        for (const rec of records) {
          if (rec.booted && !toStop.has(rec.id) && rec.dependsOn.some((d) => toStop.has(d))) {
            toStop.add(rec.id);
            added = true;
          }
        }
      }

      // Tear down dependents before dependencies (reverse layer + topological order).
      const stopOrdered = [...toStop].sort((a, b) => {
        const ra = recordsById.get(a)!;
        const rb = recordsById.get(b)!;
        if (LAYER_ORDER[ra.layer] !== LAYER_ORDER[rb.layer]) {
          return LAYER_ORDER[rb.layer] - LAYER_ORDER[ra.layer];
        }
        return rb.id.localeCompare(ra.id);
      });
      // Topological refinement: ensure any dependent stops before its dependency.
      const finalStopOrder: string[] = [];
      const stoppedSet = new Set<string>();
      const visitStop = (id: string, stack = new Set<string>()) => {
        if (stoppedSet.has(id) || stack.has(id)) return;
        stack.add(id);
        for (const candidate of stopOrdered) {
          const cr = recordsById.get(candidate);
          if (cr && cr.dependsOn.includes(id)) visitStop(candidate, stack);
        }
        stack.delete(id);
        stoppedSet.add(id);
        finalStopOrder.push(id);
      };
      for (const id of stopOrdered) visitStop(id);

      for (const id of finalStopOrder) {
        const rec = recordsById.get(id);
        if (rec) disposeRecord(rec, true);
      }

      const freshGraph = resolveAllStates();
      syncAllLiveStatuses(freshGraph.statuses);

      for (const rec of freshGraph.ordered) {
        if (rec.booted) continue;
        const depFailed = rec.dependsOn.some((depId) => {
          const dep = recordsById.get(depId);
          return !dep || !!dep.runtimeError || dep.standalonePaused || !dep.booted;
        });
        if (depFailed) {
          emitStatusChange(rec.id, { active: false, reason: 'dep-unavailable' });
          continue;
        }
        void bootRecord(rec);
      }
    },
    getStatus(id: string): ModuleStatus {
      const live = liveStatuses.get(id);
      if (live) return live;
      const graph = resolveAllStates();
      return graph.statuses[id] || { active: false, reason: 'disabled' };
    },
    resolveStagedStates(stagedEnabled: Record<string, boolean>): Record<string, ModuleStatus> {
      return resolveAllStates(stagedEnabled).statuses;
    },
    onStatusChange(cb: (id: string, status: ModuleStatus) => void): () => void {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },
    async probeStandalone(id: string): Promise<boolean> {
      const rec = recordsById.get(id);
      if (!rec?.standalone) return false;
      let found = false;
      try {
        found = !!(await rec.standalone.probe());
      } catch {
        found = false;
      }
      rec.standalonePaused = found;
      const graph = resolveAllStates();
      syncAllLiveStatuses(graph.statuses);
      return found;
    }
  };
}

export { registerAccountProvider, clearAccountSecrets };
