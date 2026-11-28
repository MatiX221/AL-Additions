import { GM_xmlhttpRequest } from 'vite-plugin-monkey/dist/client';
import { Settings } from '../settings/settings';
import {
  type AccountProvider,
  type AniListClient,
  type AniListSession,
  type ChannelLogger,
  type CleanupFn,
  type CoreHooksApi,
  type FeatureContext,
  type FeatureLayer,
  type HttpClient,
  type HttpDownloadOptions,
  type HttpRequestOptions,
  type MigrateContext,
  type ModuleDebugDef,
  type ModuleDef,
  type ModuleDisableReason,
  type ModuleHost,
  type ModuleLayer,
  type ModuleMeta,
  type ModuleStatus,
  type MountHandle,
  type MountSpec,
  type PersistentCache,
  type RouteContext,
  type ServiceMap,
  type StorageScope
} from '../types';
import {
  composeAbortSignals,
  createCoreLogger,
  createLogger,
  downloadFile,
  getDebuggableChannels,
  isDebugEnabled,
  persistent,
  store
} from '../utils/helpers';
import {
  clearAccountSecrets,
  getAccountProvider,
  registerAccountProvider,
  watchAccountProvider
} from './accounts';
import { CoreHooks, EventBus, ServiceRegistry } from './bus';
import { createContextScope, drainCleanupsReverse, scopeAniListClient, type ContextScopeCounters } from './contextScope';
import { registerMenuCommand } from './menu';
import { Core } from './observer';
import { addStyle } from './styles';
import { showToast, toastError, toastSuccess } from './toast';

const coreLog = createCoreLogger('core');

export const modules: ModuleDef[] = [];

const LAYER_ORDER: Record<ModuleLayer, number> = {
  intercept: 0,
  preload: 1,
  service: 2,
  feature: 3,
  shell: 4
};

const ID_RE = /^[a-z][A-Za-z0-9]*$/;
const RESERVED_MODULE_IDS = new Set(['core', 'devMode']);
const teardownStarters = new WeakMap<Set<CleanupFn>, () => void>();

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
  title: string;
  help: string;
  setting: string | null;
  hosts: string[];
  layer: ModuleLayer;
  early: boolean;
  requiresReload: boolean;
  dependsOn: string[];
  after: string[];
  accounts: string[];
  debug?: ModuleDebugDef;
  standalone?: ModuleMeta['standalone'];
  migrate?: (m: MigrateContext) => void;
  setup: (ctx: FeatureContext<any, any>) => void | Promise<void>;
  legacyInit?: () => void | Promise<void>;
  invalidId: boolean;
  idCollision: boolean;
  standalonePaused: boolean;
  runtimeError?: string;
  booted: boolean;
  bootSeq: number;
  cleanups: Set<CleanupFn>;
  abortController: AbortController | null;
}

const records: ModuleRecord[] = [];
const recordsById = new Map<string, ModuleRecord>();
const invalidIds = new Map<string, ModuleStatus>();
const liveStatuses = new Map<string, ModuleStatus>();
const statusListeners = new Set<(id: string, status: ModuleStatus) => void>();
let deferredStarted = false;

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
        coreLog.error('Module status listener failed:', e);
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
    if (st.active) {
      const rec = recordsById.get(id);
      if (!rec || !rec.booted || rec.standalonePaused || rec.runtimeError) {
        emitStatusChange(id, { active: false });
        continue;
      }
    }
    emitStatusChange(id, st);
  }
}

function createScopedStorage(
  storagePrefix: string,
  isDisposed: () => boolean,
  wrapWatch: (fn: () => CleanupFn) => CleanupFn = (fn) => fn(),
  guardClear = false,
  onClear?: () => void
): StorageScope {
  return {
    get: <T>(k: string, d?: T) => store.get<T>(`${storagePrefix}${k}`, d),
    set: <T>(k: string, v: T) => {
      if (!isDisposed()) store.set(`${storagePrefix}${k}`, v);
    },
    del: (k: string) => {
      if (!isDisposed()) store.del(`${storagePrefix}${k}`);
    },
    watch: (k, cb) => {
      if (isDisposed()) return () => {};
      return wrapWatch(() =>
        store.watch(`${storagePrefix}${k}`, (_fullKey, oldV, newV, remote) => {
          if (isDisposed()) return;
          cb(k, oldV, newV, remote);
        })
      );
    },
    clear: () => {
      if (guardClear && isDisposed()) return;
      onClear?.();
      for (const k of store.list()) {
        if (k.startsWith(storagePrefix)) store.del(k);
      }
    }
  };
}

function runCleanupsReverse(id: string, cleanups: Set<CleanupFn>): void {
  teardownStarters.get(cleanups)?.();
  drainCleanupsReverse(id, cleanups, (err) => {
    coreLog.error(`Module "${id}" failed during cleanup:`, err);
  });
}

function createContextForRecord(
  rec: ModuleRecord,
  cleanups: Set<CleanupFn>,
  ac: AbortController
): FeatureContext<any, any> {
  let disposed = false;
  let tearingDown = false;
  const isClosed = (): boolean => disposed || tearingDown;
  let localClearingDepth = 0;
  const noop: CleanupFn = () => {};
  const activeRequests = new Set<{ abort?: () => void; reject?: (e: Error) => void; cleanupAbort?: () => void }>();
  const persistentHandles = new Set<{ cancel: () => void; flush: () => void }>();
  let pagehideRegistered = false;
  const counters: ContextScopeCounters = { idSeq: 0, styleSeq: 0, modalSeq: 0 };

  teardownStarters.set(cleanups, () => {
    tearingDown = true;
    try {
      ac.abort();
    } catch (e) {
      coreLog.error(`Module "${rec.id}" failed during abort:`, e);
    }
  });

  const rootScope = createContextScope({
    prefix: rec.id,
    signal: ac.signal,
    isClosed,
    cleanups,
    styleKind: 'style',
    counters,
    onError: (e) => coreLog.error(`Module "${rec.id}" failed during cleanup:`, e)
  });

  const track = rootScope.track;
  const whenAlive = rootScope.whenAlive;

  track(() => {
    disposed = true;
    while (localClearingDepth > 0) {
      localClearingDepth--;
      try {
        CoreHooks.setSessionClearing(false);
      } catch {}
    }
    ac.abort();
    for (const req of [...activeRequests]) {
      try {
        req.cleanupAbort?.();
      } catch {}
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
  const allowedAccounts = new Set(rec.accounts);
  const assertAccountAllowed = (id: string): void => {
    if (!allowedAccounts.has(id)) {
      throw new Error(`Module "${rec.id}" cannot access account provider "${id}" without declaring it in accounts`);
    }
  };

  let mountSeq = 0;

  const addMount = <T extends Element = HTMLElement>(
    spec: MountSpec<T>,
    trackFn: <F extends CleanupFn>(fn: F) => F,
    signal?: AbortSignal
  ): MountHandle<T> => {
    const resolvedId = spec.id ? rootScope.getId(spec.id) : `ala-${rec.id}-mount-${++mountSeq}`;
    const selector = `#${resolvedId}`;
    if (isClosed() || signal?.aborted) {
      return { id: resolvedId, selector, el: () => null, unmount: noop, refresh: noop };
    }
    let mountedEl: T | null = null;
    let elCleanup: CleanupFn | null = null;
    let mountDisposed = false;
    let ownDisposer: CleanupFn | null = null;
    let mountStyleDisposer: CleanupFn | null = null;

    const runElCleanup = () => {
      const fn = elCleanup;
      elCleanup = null;
      if (fn) {
        try {
          fn();
        } catch (e) {
          coreLog.error(`Module "${rec.id}" mount onMount cleanup failed:`, e);
        }
      }
    };

    const invokeOnMount = (el: T) => {
      runElCleanup();
      if (!spec.onMount) return;
      try {
        const res = spec.onMount(el);
        if (typeof res === 'function') {
          if (mountDisposed || isClosed() || signal?.aborted) {
            try {
              res();
            } catch (e) {
              coreLog.error(`Module "${rec.id}" mount onMount cleanup failed:`, e);
            }
          } else {
            elCleanup = res;
          }
        }
      } catch (e) {
        coreLog.error(`Module "${rec.id}" mount onMount failed:`, e);
      }
    };

    const ensureStyle = () => {
      if (spec.style !== undefined && !mountStyleDisposer) {
        const styleCss = spec.style;
        mountStyleDisposer = addStyle(
          `${resolvedId}-style`,
          typeof styleCss === 'function' ? () => styleCss(selector) : styleCss
        );
      }
    };

    const ensureOwnUi = () => {
      if (spec.ownUi && !ownDisposer) {
        ownDisposer = Core.registerOwnUi(selector);
      }
    };

    const tryMount = () => {
      if (mountDisposed || isClosed() || signal?.aborted) return;
      if (spec.match && !spec.match()) {
        if (mountedEl) {
          runElCleanup();
          mountedEl.remove();
          mountedEl = null;
        }
        return;
      }
      if (mountedEl?.isConnected) return;
      if (mountedEl) {
        runElCleanup();
        mountedEl = null;
      }
      const existing = document.getElementById(resolvedId) as T | null;
      if (existing?.isConnected) {
        ensureStyle();
        ensureOwnUi();
        mountedEl = existing;
        invokeOnMount(existing);
        return;
      }
      const anchor = typeof spec.anchor === 'string' ? document.querySelector(spec.anchor) : spec.anchor();
      if (!anchor) return;
      const pos = spec.position ?? 'afterend';
      if ((pos === 'beforebegin' || pos === 'afterend') && !anchor.parentElement) return;
      const el = spec.create();
      if (!el) return;
      el.id = resolvedId;
      ensureStyle();
      anchor.insertAdjacentElement(pos, el);
      mountedEl = el;
      ensureOwnUi();
      invokeOnMount(el);
    };

    let unsubReady: CleanupFn = noop;
    let unsubNav: CleanupFn = noop;
    let unsubBody: CleanupFn = noop;
    let disposeTracked: CleanupFn = noop;

    const disposeMount = () => {
      if (mountDisposed) return;
      mountDisposed = true;
      signal?.removeEventListener('abort', disposeTracked);
      unsubReady();
      unsubNav();
      unsubBody();
      runElCleanup();
      ownDisposer?.();
      ownDisposer = null;
      mountStyleDisposer?.();
      mountStyleDisposer = null;
      mountedEl?.remove();
      mountedEl = null;
    };

    unsubReady = Core.ready(tryMount);
    unsubNav = Core.onNavigate(tryMount);
    unsubBody = Core.onBodyMutation(tryMount);
    if (isClosed() || signal?.aborted) {
      disposeMount();
      return { id: resolvedId, selector, el: () => null, unmount: noop, refresh: noop };
    }
    disposeTracked = trackFn(disposeMount);
    signal?.addEventListener('abort', disposeTracked, { once: true });
    return {
      id: resolvedId,
      selector,
      el: () =>
        mountDisposed || isClosed() || signal?.aborted
          ? null
          : (document.getElementById(resolvedId) as T | null),
      unmount: disposeTracked,
      refresh: tryMount
    };
  };

  const makeHttpClient = (scopeSignal?: AbortSignal): HttpClient => {
    const request = (url: string, opts: HttpRequestOptions = {}): Promise<any> => {
      const { signal: callerSignal, ...xhrOpts } = opts || {};
      if (isClosed() || ac.signal.aborted || scopeSignal?.aborted || callerSignal?.aborted) {
        return Promise.reject(new Error('Request aborted'));
      }
      const composed = scopeSignal ? composeAbortSignals(scopeSignal, callerSignal) : { signal: callerSignal, dispose: noop };
      const effectiveSignal = composed.signal;
      if (effectiveSignal?.aborted) {
        composed.dispose();
        return Promise.reject(new Error('Request aborted'));
      }
      return new Promise((resolve, reject) => {
        let handle: any;
        const entry: { abort?: () => void; reject?: (e: Error) => void; cleanupAbort?: () => void } = { reject };
        activeRequests.add(entry);
        const onAbort = () => {
          try {
            handle?.abort?.();
          } catch {}
          settle(() => reject(new Error('Request aborted')));
        };
        const settle = (fn: () => void) => {
          if (!activeRequests.has(entry)) return;
          activeRequests.delete(entry);
          effectiveSignal?.removeEventListener('abort', onAbort);
          composed.dispose();
          fn();
        };
        entry.cleanupAbort = () => {
          effectiveSignal?.removeEventListener('abort', onAbort);
          composed.dispose();
        };
        effectiveSignal?.addEventListener('abort', onAbort, { once: true });
        const g = globalThis as any;
        const xhr =
          (Object.prototype.hasOwnProperty.call(g, 'GM_xmlhttpRequest') && typeof g.GM_xmlhttpRequest === 'function'
            ? g.GM_xmlhttpRequest
            : GM_xmlhttpRequest) as typeof GM_xmlhttpRequest;
        try {
          handle = xhr({
            method: 'GET',
            timeout: 15000,
            ...(xhrOpts as any),
            url,
            onload: (res: any) => settle(() => resolve(res)),
            onerror: () => settle(() => reject(new Error('Network error'))),
            ontimeout: () => settle(() => reject(new Error('Timeout'))),
            onabort: () => settle(() => reject(new Error('Request aborted')))
          });
        } catch (err) {
          settle(() => reject(err));
          return;
        }
        if (effectiveSignal?.aborted) {
          onAbort();
          return;
        }
        entry.abort = () => {
          try {
            handle?.abort?.();
          } catch {}
        };
      });
    };

    const text = async (url: string, opts?: HttpRequestOptions): Promise<string> => {
      const r = await request(url, opts);
      if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
      return r.responseText || '';
    };

    const json = async <T = any>(url: string, opts?: HttpRequestOptions): Promise<T> => {
      const r = await request(url, opts);
      if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
      if (opts?.responseType === 'json' && r.response !== undefined) {
        return r.response as T;
      }
      return JSON.parse(r.responseText || '') as T;
    };

    const download = (url: string, name: string, opts: HttpDownloadOptions = {}): Promise<'download' | 'tab'> => {
      const { signal: callerSignal, ...dlOpts } = opts || {};
      if (isClosed() || ac.signal.aborted || scopeSignal?.aborted || callerSignal?.aborted) {
        return Promise.reject(new Error('Download aborted'));
      }
      const composed = scopeSignal ? composeAbortSignals(scopeSignal, callerSignal) : { signal: callerSignal, dispose: noop };
      const effectiveSignal = composed.signal;
      if (effectiveSignal?.aborted) {
        composed.dispose();
        return Promise.reject(new Error('Download aborted'));
      }
      return new Promise((resolve, reject) => {
        const entry: { abort?: () => void; reject?: (e: Error) => void; cleanupAbort?: () => void } = { reject };
        activeRequests.add(entry);
        let settled = false;
        let handle: { abort: () => void } | null = null;
        const onAbort = () => {
          settled = true;
          try {
            handle?.abort?.();
          } catch {}
          settle(() => reject(new Error('Download aborted')));
        };
        const settle = (fn: () => void) => {
          if (!activeRequests.has(entry)) return;
          activeRequests.delete(entry);
          effectiveSignal?.removeEventListener('abort', onAbort);
          composed.dispose();
          fn();
        };
        entry.cleanupAbort = () => {
          effectiveSignal?.removeEventListener('abort', onAbort);
          composed.dispose();
        };
        effectiveSignal?.addEventListener('abort', onAbort, { once: true });
        handle = downloadFile(url, name, {
          saveAs: dlOpts.saveAs,
          openTabOnError: () =>
            !isClosed() && !ac.signal.aborted && !effectiveSignal?.aborted && dlOpts.openTabOnError !== false,
          onComplete: (outcome) => {
            settled = true;
            settle(() => resolve(outcome));
          },
          onAbort: () => {
            settled = true;
            settle(() => reject(new Error('Download aborted')));
          },
          onError: (err) => {
            settled = true;
            settle(() => reject(err instanceof Error ? err : new Error(String(err || 'Download failed'))));
          }
        });
        if (!settled && effectiveSignal?.aborted) {
          onAbort();
          return;
        }
        if (!settled) {
          entry.abort = () => {
            try {
              handle?.abort?.();
            } catch {}
          };
        }
      });
    };

    return { request, text, json, download };
  };

  const rootHttp = makeHttpClient(ac.signal);

  const onRoute = (
    matchOrHandler:
      | RegExp
      | ((url: URL) => boolean)
      | ((rc: RouteContext) => void | Promise<void> | CleanupFn),
    maybeHandler?: (rc: RouteContext) => void | Promise<void> | CleanupFn
  ): CleanupFn =>
    whenAlive(() => {
      const matcher = typeof maybeHandler === 'function' ? (matchOrHandler as RegExp | ((url: URL) => boolean)) : null;
      const handler = (maybeHandler ?? matchOrHandler) as (rc: RouteContext) => void | Promise<void> | CleanupFn;

      let routeCleanups = new Set<CleanupFn>();
      let routeAc: AbortController | null = null;
      let routeSubDisposed = false;

      const teardownRoute = () => {
        routeAc?.abort();
        routeAc = null;
        runCleanupsReverse(rec.id, routeCleanups);
      };

      const evaluate = () => {
        if (routeSubDisposed || isClosed()) return;
        teardownRoute();

        let url: URL;
        try {
          url = new URL(location.href);
        } catch {
          url = new URL('https://anilist.co/');
        }

        try {
          let matchArr: RegExpMatchArray | null = null;
          if (matcher instanceof RegExp) {
            matchArr = url.pathname.match(matcher);
            if (!matchArr) return;
          } else if (typeof matcher === 'function') {
            if (!matcher(url)) return;
          }

          const localAc = new AbortController();
          routeAc = localAc;
          const localCleanups = new Set<CleanupFn>();
          routeCleanups = localCleanups;
          const routeScope = createContextScope({
            prefix: rec.id,
            signal: localAc.signal,
            isClosed: () => isClosed() || localAc.signal.aborted,
            cleanups: localCleanups,
            styleKind: 'route-style',
            counters,
            onError: (e) => coreLog.error(`Module "${rec.id}" failed during cleanup:`, e)
          });

          let routeApiWrapper: Omit<AniListClient, 'session'> | null = null;
          const rc: RouteContext = {
            url,
            pathname: url.pathname,
            match: matchArr,
            signal: localAc.signal,
            getId: routeScope.getId,
            onCleanup: routeScope.onCleanup,
            ready: (cb) =>
              routeScope.whenAlive(() =>
                Core.ready(() => {
                  if (!isClosed() && !localAc.signal.aborted) cb();
                })
              ),
            onBodyMutation: (cb) =>
              routeScope.whenAlive(() =>
                Core.onBodyMutation((mutations) => {
                  if (!isClosed() && !localAc.signal.aborted) cb(mutations);
                })
              ),
            observe: routeScope.observe,
            listen: routeScope.listen,
            interval: routeScope.interval,
            timeout: routeScope.timeout,
            debounce: routeScope.debounce,
            raf: routeScope.raf,
            mount: <T extends Element = HTMLElement>(spec: MountSpec<T>): MountHandle<T> =>
              addMount(spec, routeScope.track, localAc.signal),
            addStyle: routeScope.addStyle,
            modal: routeScope.modal,
            confirm: routeScope.confirm,
            alert: routeScope.alert,
            waitForSelector: routeScope.waitForSelector,
            http: makeHttpClient(localAc.signal),
            get api(): Omit<AniListClient, 'session'> {
              if (!routeApiWrapper) {
                routeApiWrapper = scopeAniListClient(
                  getCoreApi,
                  localAc.signal,
                  () => isClosed() || localAc.signal.aborted
                );
              }
              return routeApiWrapper;
            }
          };

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
                  coreLog.error(`Module "${rec.id}" route handler failed:`, err);
                  if (routeAc === localAc) {
                    teardownRoute();
                  }
                }
              }
            );
          }
        } catch (err) {
          coreLog.error(`Module "${rec.id}" route handler failed:`, err);
          teardownRoute();
        }
      };

      evaluate();
      const unsubNav = routeSubDisposed || isClosed() ? noop : Core.onNavigate(evaluate);

      const disposeRouteWatcher = () => {
        if (routeSubDisposed) return;
        routeSubDisposed = true;
        unsubNav();
        teardownRoute();
      };
      return disposeRouteWatcher;
    });

  const contextFetchLeases = new Set<CleanupFn>();
  const trackedHooks: CoreHooksApi = {
    setSessionClearing: (active) => {
      if (disposed) return;
      if (tearingDown && active) return;
      if (active) {
        localClearingDepth++;
        CoreHooks.setSessionClearing(true);
      } else if (localClearingDepth > 0) {
        localClearingDepth--;
        CoreHooks.setSessionClearing(false);
      }
    },
    isSessionClearing: () => CoreHooks.isSessionClearing(),
    getAuthHeader: () => CoreHooks.getAuthHeader(),
    setAuthHeader: (header) => {
      if (!isClosed()) CoreHooks.setAuthHeader(header);
    },
    clearAuth: () => {
      if (!isClosed()) CoreHooks.clearAuth();
    },
    registerCacheBridge: (bridge) => whenAlive(() => CoreHooks.registerCacheBridge(bridge)),
    getCacheBridge: () => CoreHooks.getCacheBridge(),
    markFetchOwner: (active) => {
      if (!active) {
        if (!disposed) {
          for (const release of [...contextFetchLeases]) {
            release();
          }
          contextFetchLeases.clear();
        }
        return noop;
      }
      if (isClosed()) return noop;
      let leaseRef: CleanupFn = noop;
      const rawRelease = CoreHooks.markFetchOwner(true);
      leaseRef = track(() => {
        contextFetchLeases.delete(leaseRef);
        rawRelease();
      });
      contextFetchLeases.add(leaseRef);
      return leaseRef;
    },
    hasGqlFetchSubscribers: () => CoreHooks.hasGqlFetchSubscribers(),
    emitGqlFetch: (event) => {
      if (!isClosed()) CoreHooks.emitGqlFetch(event);
    },
    onGqlFetch: (cb) => whenAlive(() => CoreHooks.onGqlFetch(cb)),
    blockRpc: (fn) => whenAlive(() => CoreHooks.blockRpc(fn)),
    isRpcBlocked: (q, v) => CoreHooks.isRpcBlocked(q, v),
    setPrefetchPaused: (paused) => whenAlive(() => CoreHooks.setPrefetchPaused(paused)),
    isPrefetchSuppressed: () => CoreHooks.isPrefetchSuppressed()
  };

  const debugDef = rec.debug;
  const hasModuleDebug = Boolean(debugDef && debugDef.debug !== false);
  const debugLabel = debugDef?.label || rec.title || rec.id;
  const debugTitle = hasModuleDebug ? (debugDef as { title?: string }).title || rec.title : rec.title;
  const debugHelp = hasModuleDebug ? (debugDef as { help?: string }).help ?? rec.help : rec.help;
  const hasDebuggableChannels = getDebuggableChannels(debugDef).length > 0;
  const rootLogger = createLogger<boolean>(
    `[${debugLabel}]`,
    hasModuleDebug
      ? () => !disposed && isDebugEnabled(rec.id, hasDebuggableChannels ? 'general' : undefined)
      : () => false,
    {
      label: debugLabel,
      title: debugTitle,
      help: debugHelp,
      canDebug: hasModuleDebug
    }
  );
  const channelLoggers = new Map<string, ChannelLogger<boolean>>();
  const getChannelLogger = (chId: string): ChannelLogger<boolean> => {
    const cached = channelLoggers.get(chId);
    if (cached) return cached;
    const chDef =
      debugDef?.channels && Object.prototype.hasOwnProperty.call(debugDef.channels, chId)
        ? debugDef.channels[chId]
        : undefined;
    if (!chDef) {
      const fallback = Object.freeze({
        id: chId,
        ...createLogger<false>(`[${debugLabel} (${chId})]`, () => false, {
          label: chId,
          title: chId,
          canDebug: false
        })
      }) as ChannelLogger<false>;
      channelLoggers.set(chId, fallback);
      return fallback;
    }
    const canDebug = hasModuleDebug && chDef.debug === true;
    const chLogger = Object.freeze({
      id: chId,
      ...createLogger<boolean>(
        `[${debugLabel} (${chDef.label})]`,
        canDebug ? () => !disposed && isDebugEnabled(rec.id, chId) : () => false,
        {
          label: chDef.label,
          title: chDef.title || chDef.label,
          help: chDef.help,
          canDebug
        }
      )
    }) as ChannelLogger<boolean>;
    channelLoggers.set(chId, chLogger);
    return chLogger;
  };
  const ctxLog = Object.freeze({
    ...rootLogger,
    channel: (chId: string) => getChannelLogger(String(chId))
  });

  let sessionWrapper: AniListSession | null = null;
  let apiWrapper: Omit<AniListClient, 'session'> | null = null;
  const getSessionWrapper = (): AniListSession => {
    if (!sessionWrapper) {
      sessionWrapper = {
        peek: (opts) =>
          getCoreSession().peek(isClosed() && opts?.reconcile ? { ...opts, reconcile: false } : opts),
        get userId() {
          return getCoreSession().userId;
        },
        get username() {
          return getCoreSession().username;
        },
        get scoreFormat() {
          return getCoreSession().scoreFormat;
        },
        hasAuth: (opts) =>
          getCoreSession().hasAuth(isClosed() ? { ...opts, reconcile: false } : opts),
        clear: () => {
          if (!isClosed()) getCoreSession().clear();
        },
        syncFromPage: () => {
          if (!isClosed()) getCoreSession().syncFromPage?.();
        },
        recordHint: (hint) => {
          if (!isClosed()) getCoreSession().recordHint(hint);
        }
      };
    }
    return sessionWrapper;
  };
  const getApiWrapper = (): Omit<AniListClient, 'session'> => {
    if (!apiWrapper) {
      apiWrapper = scopeAniListClient(getCoreApi, ac.signal, isClosed);
    }
    return apiWrapper;
  };

  const eventOwner = Symbol(`events:${rec.id}`);
  let retainedTracked = false;

  const cancelAllPersistent = () => {
    for (const h of persistentHandles) {
      h.cancel();
    }
  };

  const ctx: FeatureContext<any, any> = {
    id: rec.id,
    title: rec.title,
    help: rec.help,
    signal: ac.signal,
    getId: rootScope.getId,
    get: (key) => Settings.get(key),
    set: (key, val) => {
      if (!isClosed()) Settings.set(key, val);
    },
    storage: createScopedStorage(storagePrefix, () => disposed, whenAlive, false, cancelAllPersistent),
    persistent: <T extends Record<string, any>>(key: string, prune?: (data: T) => void): PersistentCache<T> => {
      const p = persistent<T>(`${storagePrefix}${key}`, prune);
      const handle = { cancel: p.cancel, flush: p.flush };
      if (!isClosed()) {
        persistentHandles.add(handle);
        if (!pagehideRegistered && typeof window !== 'undefined') {
          pagehideRegistered = true;
          rootScope.listen(window, 'pagehide', () => {
            if (isClosed()) return;
            for (const h of persistentHandles) {
              h.flush();
            }
          });
        }
        track(() => {
          persistentHandles.delete(handle);
          p.cancel();
        });
      }
      return {
        get data(): T {
          return p.data;
        },
        set data(val: T) {
          p.data = val;
        },
        save: () => {
          if (!isClosed()) p.save();
        },
        cancel: () => p.cancel(),
        flush: () => {
          if (!isClosed()) p.flush();
        }
      };
    },
    ready: (cb) => whenAlive(() => Core.ready(cb)),
    onNav: (cb) => whenAlive(() => Core.onNavigate(cb)),
    onBodyMutation: (cb) => whenAlive(() => Core.onBodyMutation(cb)),
    onRoute,
    mount: <T extends Element = HTMLElement>(spec: MountSpec<T>): MountHandle<T> =>
      addMount(spec, rootScope.track, ac.signal),
    addStyle: rootScope.addStyle,
    modal: rootScope.modal,
    confirm: rootScope.confirm,
    alert: rootScope.alert,
    listen: rootScope.listen,
    interval: rootScope.interval,
    timeout: rootScope.timeout,
    debounce: rootScope.debounce,
    raf: rootScope.raf,
    observe: rootScope.observe,
    trackEl: <T extends Element>(el: T): T => {
      track(() => el.remove());
      return el;
    },
    waitForSelector: rootScope.waitForSelector,
    silently: (fn) => {
      if (!isClosed()) Core.silently(fn);
    },
    ownUi: (selector) => whenAlive(() => Core.registerOwnUi(selector)),
    onCleanup: rootScope.onCleanup,
    http: rootHttp,
    get api(): Omit<AniListClient, 'session'> {
      return getApiWrapper();
    },
    get session(): AniListSession {
      return getSessionWrapper();
    },
    accounts: {
      get: (id: string): AccountProvider | undefined => {
        assertAccountAllowed(id);
        return getAccountProvider(id);
      },
      isConnected: (id: string): boolean => {
        assertAccountAllowed(id);
        return !!getAccountProvider(id)?.isConnected();
      },
      connect: (id: string) => {
        assertAccountAllowed(id);
        if (!isClosed()) getAccountProvider(id)?.connect();
      },
      disconnect: (id: string) => {
        assertAccountAllowed(id);
        if (!isClosed()) getAccountProvider(id)?.disconnect();
      },
      clearSecrets: (providerId?: string) => {
        if (providerId !== undefined) {
          assertAccountAllowed(providerId);
          if (!isClosed()) clearAccountSecrets(providerId);
          return;
        }
        if (isClosed()) return;
        for (const id of allowedAccounts) clearAccountSecrets(id);
      },
      watch: (id: string, cb: (connected: boolean) => void): CleanupFn => {
        assertAccountAllowed(id);
        return whenAlive(() => watchAccountProvider(id, cb));
      }
    },
    toast: {
      show: (msg, opts) => {
        if (!isClosed()) showToast(msg, opts);
      },
      success: (msg, opts) => {
        if (!isClosed()) toastSuccess(msg, opts);
      },
      error: (msg, opts) => {
        if (!isClosed()) toastError(msg, opts);
      }
    },
    menuCommand: (label, onClick) => whenAlive(() => registerMenuCommand(label, onClick)),
    services: {
      provide: (localName, impl) =>
        whenAlive(() => ServiceRegistry.provide(`${rec.id}:${String(localName)}` as keyof ServiceMap, impl as never)),
      get: (fullName) => ServiceRegistry.get(fullName),
      onAvailable: (fullName, cb) => whenAlive(() => ServiceRegistry.onAvailable(fullName, cb))
    },
    events: {
      emit: (event, ...args) => {
        if (!isClosed()) EventBus.emit(event, ...args);
      },
      emitRetained: (event, ...args) => {
        if (isClosed()) return;
        if (!retainedTracked) {
          retainedTracked = true;
          track(() => EventBus.clearRetainedByOwner(eventOwner));
        }
        EventBus.emitRetainedOwned(eventOwner, event, ...args);
      },
      on: (event, cb) => whenAlive(() => EventBus.on(event, cb)),
      onRetained: (event, cb) => whenAlive(() => EventBus.onRetained(event, cb))
    },
    hooks: trackedHooks,
    log: ctxLog as any,
    setStandalonePaused: (paused: boolean) => {
      if (isClosed()) return;
      const next = !!paused;
      rec.standalonePaused = next;
      if (next) {
        cascadeDispose([rec.id], { preserveStandaloneSeeds: true });
      }
      const graph = resolveAllStates();
      syncAllLiveStatuses(graph.statuses);
    }
  };

  return ctx;
}

function disposeRecord(rec: ModuleRecord, resetStandalone = true): void {
  rec.bootSeq++;
  const hadCleanups = rec.cleanups.size > 0;
  if (rec.booted || hadCleanups) {
    runCleanupsReverse(rec.id, rec.cleanups);
  }
  rec.abortController = null;
  rec.booted = false;
  rec.runtimeError = undefined;
  if (resetStandalone) rec.standalonePaused = false;
}

function getFailedDeps(rec: ModuleRecord): string[] {
  return rec.dependsOn.filter((depId) => {
    const dep = recordsById.get(depId);
    return !dep || !!dep.runtimeError || dep.standalonePaused || !dep.booted;
  });
}

function cascadeDispose(seedIds: string[], opts: { preserveStandaloneSeeds?: boolean } = {}): string[] {
  const seedSet = new Set(seedIds);
  const toStop = new Set<string>();
  for (const rec of records) {
    if (rec.booted && seedSet.has(rec.id)) {
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
  if (toStop.size === 0) return [];

  const stopOrdered = [...toStop].sort((a, b) => {
    const ra = recordsById.get(a)!;
    const rb = recordsById.get(b)!;
    if (LAYER_ORDER[ra.layer] !== LAYER_ORDER[rb.layer]) {
      return LAYER_ORDER[rb.layer] - LAYER_ORDER[ra.layer];
    }
    return rb.id.localeCompare(ra.id);
  });
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
    if (!rec) continue;
    const resetStandalone = !(opts.preserveStandaloneSeeds && seedSet.has(id));
    disposeRecord(rec, resetStandalone);
  }
  return finalStopOrder;
}

function bootRecord(rec: ModuleRecord): Promise<void> {
  if (rec.booted) return Promise.resolve();
  const seq = ++rec.bootSeq;
  rec.runtimeError = undefined;
  const ac = new AbortController();
  const cleanups = new Set<CleanupFn>();
  rec.cleanups = cleanups;
  rec.abortController = ac;
  rec.booted = true;

  const ctx = createContextForRecord(rec, cleanups, ac);
  coreLog.debug(`Initializing module "${rec.id}" (layer=${rec.layer}, early=${rec.early})`);

  const handleFailure = (err: unknown) => {
    if (rec.bootSeq !== seq) return;
    const msg = err instanceof Error ? err.message : String(err);
    coreLog.error(`Module "${rec.id}" failed during setup:`, err);
    cascadeDispose([rec.id]);
    rec.runtimeError = msg;
    const graph = resolveAllStates();
    syncAllLiveStatuses(graph.statuses);
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
            return;
          }
          if (!rec.runtimeError && rec.booted) {
            emitStatusChange(rec.id, { active: true });
          }
        },
        (err) => {
          handleFailure(err);
        }
      );
    }
    if (rec.standalonePaused) {
      rec.booted = false;
      return Promise.resolve();
    }
    if (!rec.runtimeError && rec.booted) {
      emitStatusChange(rec.id, { active: true });
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

export function defineModule<
  TId extends string = string,
  const TDebug extends ModuleDebugDef<any> | undefined = undefined,
  const TAccounts extends readonly string[] = readonly []
>(meta: ModuleMeta<TId, TDebug, TAccounts>): void {
  if (!ID_RE.test(meta.id) || RESERVED_MODULE_IDS.has(meta.id)) {
    coreLog.error(`Invalid or reserved module ID "${meta.id}". Must match ${ID_RE} and not be reserved.`);
    invalidIds.set(meta.id, { active: false, reason: 'invalid-id' });
    emitStatusChange(meta.id, { active: false, reason: 'invalid-id' });
    return;
  }

  const existing = recordsById.get(meta.id);
  if (existing) {
    coreLog.error(`Duplicate module ID "${meta.id}" ignored.`);
    existing.idCollision = true;
    emitStatusChange(meta.id, { active: false, reason: 'id-collision' });
    return;
  }

  const layer: FeatureLayer = meta.layer ?? 'feature';
  const hosts = meta.hosts?.length ? meta.hosts.slice() : ['anilist.co'];
  const dependsOn = (meta.dependsOn || []).slice();
  const after = (meta.after || []).slice();
  const accounts = meta.accounts ? [...meta.accounts] : [];

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
    accounts: accounts.length ? accounts : undefined,
    debug: meta.debug,
    standalone: meta.standalone
  });

  registerRecord({
    id: meta.id,
    title: meta.title,
    help: meta.help,
    setting: meta.key,
    hosts,
    layer,
    early: layer === 'intercept' || layer === 'preload',
    requiresReload: !!meta.requiresReload,
    dependsOn,
    after,
    accounts,
    debug: meta.debug,
    standalone: meta.standalone,
    migrate: meta.migrate,
    setup: meta.setup as (ctx: FeatureContext<any, any>) => void | Promise<void>,
    invalidId: false,
    idCollision: false,
    standalonePaused: false,
    booted: false,
    bootSeq: 0,
    cleanups: new Set(),
    abortController: null
  });
}

export function registerShellModule(
  name: string,
  init: () => void | Promise<void> | CleanupFn,
  hosts: string[] = ['anilist.co']
): void {
  if (!ID_RE.test(name) || RESERVED_MODULE_IDS.has(name)) {
    coreLog.error(`Invalid or reserved shell module ID "${name}". Must match ${ID_RE} and not be reserved.`);
    invalidIds.set(name, { active: false, reason: 'invalid-id' });
    emitStatusChange(name, { active: false, reason: 'invalid-id' });
    return;
  }

  const existing = recordsById.get(name);
  if (existing) {
    coreLog.error(`Duplicate module ID "${name}" ignored.`);
    existing.idCollision = true;
    emitStatusChange(name, { active: false, reason: 'id-collision' });
    return;
  }

  const runShellInit = (ctx?: FeatureContext<any, any>): void | Promise<void> => {
    const res = init();
    if (typeof res === 'function') {
      ctx?.onCleanup(res);
      return;
    }
    return res;
  };

  registerRecord({
    id: name,
    title: name,
    help: '',
    setting: null,
    hosts: hosts.slice(),
    layer: 'shell',
    early: false,
    requiresReload: true,
    dependsOn: [],
    after: [],
    accounts: [],
    setup: (ctx) => runShellInit(ctx),
    legacyInit: () => runShellInit(),
    invalidId: false,
    idCollision: false,
    standalonePaused: false,
    booted: false,
    bootSeq: 0,
    cleanups: new Set(),
    abortController: null
  });
}

export function runMigrations(): void {
  Settings.migrate();

  const layers: ModuleLayer[] = ['intercept', 'preload', 'service', 'feature', 'shell'];
  for (const layer of layers) {
    const layerRecs = records
      .filter((r) => !r.invalidId && !r.idCollision && r.layer === layer)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const rec of layerRecs) {
      if (!rec.migrate) continue;
      let migrateDone = false;
      const migrationCtx: MigrateContext = {
        id: rec.id,
        storage: createScopedStorage(`ala_mod_${rec.id}_`, () => migrateDone, undefined, true),
        settings: {
          has: (key) => Settings.has(key),
          get: (key) => Settings.get(key),
          set: (key, val) => {
            if (!migrateDone) Settings.set(key, val);
          }
        },
        legacy: {
          get: <T>(key: string, def?: T) => store.get<T>(key, def),
          set: <T>(key: string, val: T) => {
            if (!migrateDone) store.set(key, val);
          },
          del: (key) => {
            if (!migrateDone) store.del(key);
          },
          getLocal: (key) => {
            try {
              return localStorage.getItem(key);
            } catch {
              return null;
            }
          },
          delLocal: (key) => {
            if (migrateDone) return;
            try {
              localStorage.removeItem(key);
            } catch {}
          }
        }
      };
      try {
        rec.migrate(migrationCtx);
      } catch (e) {
        coreLog.error(`Module "${rec.id}" failed during migrate:`, e);
      } finally {
        migrateDone = true;
      }
    }
  }
}

export function startModules(early: boolean): void {
  if (!early) deferredStarted = true;
  const graph = resolveAllStates();
  syncAllLiveStatuses(graph.statuses);

  for (const rec of graph.ordered) {
    if (rec.early !== early) continue;
    const failedDeps = getFailedDeps(rec);
    if (failedDeps.length > 0) {
      emitStatusChange(rec.id, { active: false, reason: 'dep-unavailable', missingDeps: failedDeps });
      continue;
    }
    void bootRecord(rec);
  }
}

export function disposeFeature(id: string): void {
  const rec = recordsById.get(id);
  if (!rec) return;
  const stopped = cascadeDispose([id]);
  if (stopped.length === 0) return;
  for (const stoppedId of stopped) {
    if (stoppedId === id) {
      emitStatusChange(stoppedId, { active: false, reason: 'disabled' });
    } else {
      const depRec = recordsById.get(stoppedId);
      const missingDeps = depRec ? getFailedDeps(depRec) : [id];
      emitStatusChange(stoppedId, {
        active: false,
        reason: 'dep-unavailable',
        missingDeps: missingDeps.length ? missingDeps : [id]
      });
    }
  }
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
    get api(): AniListClient | undefined {
      return configuredServices?.api;
    },
    reload(ids: string[]): void {
      const targetSet = new Set(ids);
      const graph = resolveAllStates();
      const nextActiveIds = new Set(graph.ordered.map((r) => r.id));

      const seedIds = records
        .filter((rec) => rec.booted && (targetSet.has(rec.id) || !nextActiveIds.has(rec.id)))
        .map((rec) => rec.id);
      cascadeDispose(seedIds);

      for (const id of targetSet) {
        const rec = recordsById.get(id);
        if (rec && !rec.booted) {
          rec.runtimeError = undefined;
          if (rec.standalone) {
            let probeRes: boolean | Promise<boolean> = false;
            try {
              probeRes = rec.standalone.probe();
            } catch {
              probeRes = false;
            }
            if (probeRes && typeof (probeRes as Promise<boolean>).then === 'function') {
              rec.standalonePaused = false;
              Promise.resolve(probeRes).then(
                (found) => {
                  if (!found) return;
                  rec.standalonePaused = true;
                  cascadeDispose([rec.id], { preserveStandaloneSeeds: true });
                  const postGraph = resolveAllStates();
                  syncAllLiveStatuses(postGraph.statuses);
                },
                () => {}
              );
            } else {
              rec.standalonePaused = !!probeRes;
            }
          } else {
            rec.standalonePaused = false;
          }
        }
      }

      const freshGraph = resolveAllStates();
      syncAllLiveStatuses(freshGraph.statuses);

      for (const rec of freshGraph.ordered) {
        if (rec.booted) continue;
        if (!rec.early && !deferredStarted && !document.body) continue;
        const failedDeps = getFailedDeps(rec);
        if (failedDeps.length > 0) {
          emitStatusChange(rec.id, { active: false, reason: 'dep-unavailable', missingDeps: failedDeps });
          continue;
        }
        void bootRecord(rec);
      }
    },
    getStatus(id: string): ModuleStatus {
      const live = liveStatuses.get(id);
      if (live) return live;
      const graph = resolveAllStates();
      const st = graph.statuses[id];
      if (!st) return { active: false, reason: 'disabled' };
      if (st.active) {
        const rec = recordsById.get(id);
        if (!rec || !rec.booted || rec.standalonePaused || rec.runtimeError) {
          return { active: false };
        }
      }
      return st;
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
      if (found) {
        cascadeDispose([rec.id], { preserveStandaloneSeeds: true });
      }
      const graph = resolveAllStates();
      syncAllLiveStatuses(graph.statuses);
      return found;
    }
  };
}

export { registerAccountProvider, clearAccountSecrets };
