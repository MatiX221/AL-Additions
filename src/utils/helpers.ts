import {
  GM_getValue,
  GM_setValue,
  GM_deleteValue,
  GM_listValues,
  GM_addValueChangeListener,
  GM_removeValueChangeListener,
  GM_xmlhttpRequest,
  GM_download,
  unsafeWindow
} from 'vite-plugin-monkey/dist/client';
import {
  SETTING_PREFIX,
  type CleanupFn,
  type DebouncedFn,
  type HttpDownloadOptions,
  type Logger,
  type LoggerMeta,
  type ModuleDebugChannelEnabledDef,
  type ModuleDebugDef
} from '../types';

export type { DebouncedFn };

export const HOST = location.hostname;

const MAX_TIMEOUT_MS = 0x7fffffff;

/** Resolves after `ms` milliseconds, or rejects immediately with an AbortError if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal));
  }
  const delay = Number.isFinite(ms) ? Math.min(MAX_TIMEOUT_MS, Math.max(0, ms)) : 0;
  if (!signal) {
    return new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(createAbortError(signal));
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export const clean = (s: unknown): string => String(s || '').replace(/\s+/g, ' ').trim();

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const parseToggle = (v: unknown): boolean => (v === 'false' ? false : !!v);

export const safe = <T>(fn: () => T, label?: string): T | undefined => {
  try {
    return fn();
  } catch (e) {
    console.error('[AL-Additions]', label || '', e);
  }
};

export const tryOr = async <T, F = null>(fn: () => Promise<T>, fallback: F = null as unknown as F): Promise<T | F> => {
  try {
    return await fn();
  } catch (_) {
    return fallback;
  }
};

export interface AuthError extends Error {
  auth?: string;
}

export function authError(service: string, message: string): AuthError {
  const e: AuthError = new Error(message);
  e.auth = service;
  return e;
}

export function composeAbortSignals(
  a: AbortSignal,
  b?: AbortSignal
): { signal: AbortSignal; dispose: CleanupFn };
export function composeAbortSignals(
  a?: AbortSignal,
  b?: AbortSignal
): { signal: AbortSignal | undefined; dispose: CleanupFn };
/**
 * Composes two optional AbortSignals into a single signal that aborts when either aborts,
 * falling back to manual abort-listener forwarding when AbortSignal.any is unavailable.
 */
export function composeAbortSignals(
  a?: AbortSignal,
  b?: AbortSignal
): { signal: AbortSignal | undefined; dispose: CleanupFn } {
  const noop = () => {};
  if (!a) return { signal: b, dispose: noop };
  if (!b || a === b) return { signal: a, dispose: noop };
  if (a.aborted) return { signal: a, dispose: noop };
  if (b.aborted) return { signal: b, dispose: noop };

  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') {
    return { signal: anyFn([a, b]), dispose: noop };
  }

  const ac = new AbortController();
  const dispose = () => {
    a.removeEventListener('abort', onAbortA);
    b.removeEventListener('abort', onAbortB);
  };
  const onAbortA = () => {
    dispose();
    ac.abort((a as { reason?: unknown }).reason);
  };
  const onAbortB = () => {
    dispose();
    ac.abort((b as { reason?: unknown }).reason);
  };
  a.addEventListener('abort', onAbortA, { once: true });
  b.addEventListener('abort', onAbortB, { once: true });
  return { signal: ac.signal, dispose };
}

/** Creates a standard AbortError, preserving an AbortError reason from the given signal when present. */
export function createAbortError(signal?: AbortSignal): Error {
  const reason = (signal as { reason?: unknown } | undefined)?.reason;
  if (
    (reason instanceof Error || (typeof DOMException !== 'undefined' && reason instanceof DOMException)) &&
    reason.name === 'AbortError'
  ) {
    return reason as Error;
  }
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Request aborted', 'AbortError');
  }
  const err = new Error('Request aborted');
  err.name = 'AbortError';
  return err;
}

/** Returns true when an error represents an abort/cancellation across DOMException and HttpClient aborts. */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; message?: unknown };
  return (
    e.name === 'AbortError' ||
    e.message === 'Request aborted' ||
    e.message === 'Download aborted'
  );
}

/** Races `promise` against `signal`, suppressing unhandled rejections when aborted before settlement. */
export function raceWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  createAbort: (signal?: AbortSignal) => Error = createAbortError
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(createAbort(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      promise.catch(() => {});
      reject(createAbort(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/** Returns true when a GraphQL document contains a `mutation` operation outside comments and string literals. */
export function isGqlMutation(q: string): boolean {
  if (typeof q !== 'string') return false;
  const stripped = q.replace(/#[^\n\r]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"/g, ' ');
  return /\bmutation\b/i.test(stripped);
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms = 0): DebouncedFn<T> {
  let t: ReturnType<typeof setTimeout> | 0 = 0;
  let pendingArgs: Parameters<T> | null = null;

  const cancel = () => {
    clearTimeout(t);
    t = 0;
    pendingArgs = null;
  };

  const flush = () => {
    if (!pendingArgs) return;
    const args = pendingArgs;
    cancel();
    fn(...args);
  };

  const debounced = ((...a: Parameters<T>) => {
    clearTimeout(t);
    pendingArgs = a;
    t = setTimeout(() => {
      t = 0;
      const args = pendingArgs;
      pendingArgs = null;
      if (args) fn(...args);
    }, ms);
  }) as DebouncedFn<T>;

  debounced.cancel = cancel;
  debounced.flush = flush;
  return debounced;
}

const MEMO_MAX_ENTRIES = 1000;

interface MemoOptions {
  keepNull?: boolean;
  ttl?: number;
}

export function memo<TArgs extends any[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  { keepNull = true, ttl = 0 }: MemoOptions = {}
): (key: string | number, ...args: TArgs) => Promise<TReturn> {
  const m = new Map<string, { at: number; p: Promise<TReturn> }>();
  return (key: string | number, ...args: TArgs): Promise<TReturn> => {
    const k = String(key);
    const hit = m.get(k);
    if (hit && (!ttl || Date.now() - hit.at < ttl)) return hit.p;
    const entry = { at: Date.now(), p: Promise.resolve() as unknown as Promise<TReturn> };
    entry.p = Promise.resolve()
      .then(() => fn(...args))
      .then(
        (v) => {
          if (v == null && !keepNull && m.get(k) === entry) m.delete(k);
          return v;
        },
        (e) => {
          if (m.get(k) === entry) m.delete(k);
          throw e;
        }
      );
    if (m.size >= MEMO_MAX_ENTRIES) {
      const now = Date.now();
      for (const [key, v] of m) if (ttl && now - v.at >= ttl) m.delete(key);
      while (m.size >= MEMO_MAX_ENTRIES) m.delete(m.keys().next().value as string);
    }
    m.set(k, entry);
    return entry.p;
  };
}

export function openTab(url: string): void {
  const parent = typeof document !== 'undefined' ? document.body || document.documentElement : null;
  if (!parent) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  parent.appendChild(a);
  a.click();
  a.remove();
}

function resolveGm<T extends (...args: any[]) => any>(
  name: 'GM_listValues' | 'GM_addValueChangeListener' | 'GM_removeValueChangeListener' | 'GM_download',
  imported: T | undefined
): T | null {
  const g = globalThis as any;
  if (Object.prototype.hasOwnProperty.call(g, name)) {
    return typeof g[name] === 'function' ? g[name] : null;
  }
  if (typeof window !== 'undefined' && Object.prototype.hasOwnProperty.call(window, name)) {
    const w = window as any;
    return typeof w[name] === 'function' ? w[name] : null;
  }
  return typeof imported === 'function' ? imported : null;
}

export interface DownloadFileOptions extends Omit<HttpDownloadOptions, 'openTabOnError'> {
  openTabOnError?: boolean | (() => boolean);
  onComplete?: (method: 'download' | 'tab') => void;
  onError?: (err: unknown) => void;
  onAbort?: () => void;
}

export function downloadFile(
  url: string,
  name: string,
  opts: DownloadFileOptions = {}
): { abort: () => void } | null {
  let settled = false;
  const shouldOpenTabOnError = (): boolean =>
    typeof opts.openTabOnError === 'function' ? !!opts.openTabOnError() : opts.openTabOnError !== false;
  const triggerTabFallback = (): void => {
    if (settled) return;
    settled = true;
    openTab(url);
    opts.onComplete?.('tab');
  };

  const gmDownload = resolveGm('GM_download', GM_download) as
    | ((details: Record<string, any>) => { abort?: () => void } | undefined)
    | null;
  if (gmDownload) {
    try {
      const handle = gmDownload({
        url,
        name,
        saveAs: !!opts.saveAs,
        onload: () => {
          if (settled) return;
          settled = true;
          opts.onComplete?.('download');
        },
        onerror: (err: any) => {
          if (settled) return;
          if (err?.error === 'aborted') {
            settled = true;
            opts.onAbort?.();
            return;
          }
          if (shouldOpenTabOnError()) {
            triggerTabFallback();
          } else {
            settled = true;
            opts.onError?.(err);
          }
        },
        ontimeout: () => {
          if (settled) return;
          if (shouldOpenTabOnError()) {
            triggerTabFallback();
          } else {
            settled = true;
            opts.onError?.(new Error('Download timed out'));
          }
        },
        onabort: () => {
          if (settled) return;
          settled = true;
          opts.onAbort?.();
        }
      });
      if (handle && typeof handle.abort === 'function') {
        return { abort: () => handle.abort?.() };
      }
      return null;
    } catch (err) {
      if (shouldOpenTabOnError()) {
        triggerTabFallback();
      } else if (!settled) {
        settled = true;
        opts.onError?.(err);
      }
      return null;
    }
  }

  if (shouldOpenTabOnError()) {
    triggerTabFallback();
  } else {
    settled = true;
    opts.onError?.(new Error('GM_download unavailable'));
  }
  return null;
}

export type StoreWatchCallback = (key: string, oldVal: any, newVal: any, remote: boolean) => void;

export const store = {
  get: <T>(k: string, d?: T): T => GM_getValue(k, d as any),
  set: <T>(k: string, v: T): void => GM_setValue(k, v),
  del: (k: string): void => GM_deleteValue(k),
  list: (): string[] => {
    const fn = resolveGm('GM_listValues', GM_listValues);
    if (!fn) return [];
    try {
      const keys = fn();
      return Array.isArray(keys) ? keys : [];
    } catch {
      return [];
    }
  },
  watch: (key: string, cb: StoreWatchCallback): (() => void) => {
    const addFn = resolveGm('GM_addValueChangeListener', GM_addValueChangeListener);
    if (!addFn) return () => {};
    let id: string | number | undefined;
    try {
      id = addFn(key, (name: string, oldVal: any, newVal: any, remote?: boolean) => {
        cb(name, oldVal, newVal, !!remote);
      });
    } catch {
      return () => {};
    }
    return () => {
      if (id === undefined) return;
      const listenerId = id;
      id = undefined;
      const removeFn = resolveGm('GM_removeValueChangeListener', GM_removeValueChangeListener);
      if (!removeFn) return;
      try {
        removeFn(listenerId);
      } catch {}
    };
  }
};

export const CORE_DEBUG_SCOPE = 'core';

export const CORE_DEBUG_MASTER = {
  scope: CORE_DEBUG_SCOPE,
  title: 'Core / Kernel Debug',
  help: 'Enable verbose debug logging across core subsystems, settings, and API clients.'
} as const;

export const CORE_DEBUG_CHANNELS = {
  core: {
    id: 'general',
    label: 'Core',
    title: 'Core & Observer',
    help: 'Log DOM observer mutations, route changes, module lifecycle, and core bus events.'
  },
  settings: {
    id: 'settings',
    label: 'Settings',
    title: 'Settings & Backup',
    help: 'Log settings migrations, backup creation, and restore imports.'
  },
  anilist: {
    id: 'anilist',
    label: 'AniList',
    title: 'AniList API',
    help: 'Log AniList GraphQL caching, subset matching, and API requests.'
  },
  mal: {
    id: 'mal',
    label: 'MAL',
    title: 'MyAnimeList API',
    help: 'Log MyAnimeList API requests, responses, and override cache refreshes.'
  }
} as const;

export type CoreDebugChannelId = keyof typeof CORE_DEBUG_CHANNELS;

export interface CoreLoggerOptions {
  scope: string;
  channel?: string;
  label: string;
  title?: string;
  help?: string;
}

export function getDebuggableChannels(
  debug?: ModuleDebugDef
): Array<[string, ModuleDebugChannelEnabledDef]> {
  if (!debug || debug.debug === false || !debug.channels) return [];
  const out: Array<[string, ModuleDebugChannelEnabledDef]> = [];
  for (const [id, ch] of Object.entries(debug.channels)) {
    if (ch && ch.debug === true) {
      out.push([id, ch]);
    }
  }
  return out;
}

export function isDebugEnabled(scope: string, channel?: string): boolean {
  try {
    const win = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as any;
    if (win.__ALA_DEBUG__ || win.__ALFL_DEBUG__) return true;

    const devMode = parseToggle(store.get(`${SETTING_PREFIX}devModeEnabled`, false));
    if (!devMode) return false;

    const raw = store.get<unknown>(`${SETTING_PREFIX}debug`, null);
    let map: Record<string, any> | null = null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      map = raw as Record<string, any>;
    } else if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          map = parsed;
        }
      } catch {}
    }
    if (!map) return false;

    const entry = Object.prototype.hasOwnProperty.call(map, scope) ? map[scope] : undefined;
    if (!entry || typeof entry !== 'object') return false;
    if (!parseToggle(entry.enabled)) return false;

    if (!channel) return true;
    const channels = entry.channels;
    if (!channels || typeof channels !== 'object') return true;
    if (!Object.prototype.hasOwnProperty.call(channels, channel)) return true;
    return parseToggle(channels[channel]);
  } catch {
    return false;
  }
}

export function createLogger<TCanDebug extends boolean = true>(
  prefix: string,
  isEnabled: () => boolean,
  meta: LoggerMeta
): Logger<TCanDebug> {
  const logger = {
    label: meta.label,
    title: meta.title,
    help: meta.help,
    canDebug: meta.canDebug,
    enabled: (): boolean => {
      try {
        return !!meta.canDebug && !!isEnabled();
      } catch {
        return false;
      }
    },
    debug: ((...args: any[]): void => {
      if (!logger.enabled()) return;
      console.debug(prefix, ...args);
    }) as any,
    warn: (...args: any[]): void => {
      console.warn(prefix, ...args);
    },
    error: (...args: any[]): void => {
      console.error(prefix, ...args);
    }
  };
  return Object.freeze(logger) as Logger<TCanDebug>;
}

export function createCoreLogger(channelOrOpts: CoreDebugChannelId | CoreLoggerOptions): Logger<true> {
  if (typeof channelOrOpts === 'string') {
    const def = CORE_DEBUG_CHANNELS[channelOrOpts];
    return createLogger<true>(
      `[${def.label}]`,
      () => isDebugEnabled(CORE_DEBUG_SCOPE, def.id),
      {
        label: def.label,
        title: def.title,
        help: def.help,
        canDebug: true
      }
    );
  }
  return createLogger<true>(
    `[${channelOrOpts.label}]`,
    () => isDebugEnabled(channelOrOpts.scope, channelOrOpts.channel),
    {
      label: channelOrOpts.label,
      title: channelOrOpts.title ?? channelOrOpts.label,
      help: channelOrOpts.help,
      canDebug: true
    }
  );
}

export function jsonGet<T>(key: string, fallback: T): T {
  try {
    const v = store.get<string | null>(key, null);
    if (v == null) return fallback;
    return typeof v === 'string' ? JSON.parse(v) : (v as T);
  } catch (_) {
    return fallback;
  }
}

export const jsonSet = <T>(key: string, value: T): void => store.set(key, JSON.stringify(value));

export function persistent<T extends Record<string, any>>(
  key: string,
  prune?: (data: T) => void
): { data: T; save: () => void; cancel: () => void; flush: () => void } {
  let loaded = false;
  let cacheData = {} as T;

  const ensure = (): T => {
    if (!loaded) {
      loaded = true;
      let d = jsonGet<T>(key, {} as T);
      if (!d || typeof d !== 'object' || Array.isArray(d)) d = {} as T;
      if (prune) safe(() => prune(d), 'cache prune');
      cacheData = d;
    }
    return cacheData;
  };

  const save = debounce(() => safe(() => jsonSet(key, ensure())), 500);
  return {
    get data(): T {
      return ensure();
    },
    set data(val: T) {
      loaded = true;
      cacheData = val;
    },
    save,
    cancel: () => save.cancel(),
    flush: () => save.flush()
  };
}

export const gm = {
  request(url: string, o: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) =>
      GM_xmlhttpRequest({
        method: 'GET',
        timeout: 15000,
        ...o,
        url,
        onload: resolve,
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
        onabort: () => reject(new Error('Request aborted'))
      })
    );
  },
  async text(url: string, o: Record<string, any> = {}): Promise<string> {
    const r = await gm.request(url, o);
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    return r.responseText || '';
  },
  async json<T = any>(url: string, o: Record<string, any> = {}): Promise<T> {
    return JSON.parse(await gm.text(url, o));
  }
};

export function randomString(len: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}
