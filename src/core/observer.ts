import { safe, createCoreLogger } from '../utils/helpers';
import { unsafeWindow } from 'vite-plugin-monkey/dist/client';
import type { CleanupFn } from '../types';

const coreLog = createCoreLogger('core');

interface ObserverEntry<T> {
  cb: T;
  active: boolean;
}

export const Core = (() => {
  const navCbs = new Set<ObserverEntry<() => void>>();
  const bodyCbs = new Set<ObserverEntry<(mutations: MutationRecord[]) => void>>();
  const ownSelectors = new Map<symbol, string>();
  const BASE_OWN_UI = ['#almal-panel', '#almal-toast', '#ala-toast', '#ala-media-info', '#daiya-anisongs', '#ala-settings-backdrop'];

  let observer: MutationObserver | null = null;
  let readyCancel: CleanupFn | null = null;
  let lastHref = location.href;
  let muteDepth = 0;
  const pageWin = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window;
  const patchedHistories = new WeakSet<History>();
  const PATCHED_HISTORY_SYM = Symbol.for('ala.historyPatch');
  const NAV_WATCHER_SYM = Symbol.for('ala.navWatcher');
  let navInterval: ReturnType<typeof setInterval> | 0 = 0;
  let navListening = false;
  let queued: MutationRecord[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | 0 = 0;

  interface HistoryPatchState {
    notify: () => void;
  }

  const fire = <T extends (...args: any[]) => void>(set: Set<ObserverEntry<T>>, ...args: Parameters<T>): void => {
    for (const entry of [...set]) {
      if (!entry.active) continue;
      safe(() => entry.cb(...args), 'core');
    }
  };

  function notifyNav(): void {
    if (muteDepth > 0 || location.href === lastHref) return;
    lastHref = location.href;
    coreLog.debug('Navigation detected:', location.pathname + location.search);
    fire(navCbs);
  }

  function clearGlobalNavWatcher(): void {
    const prev = (globalThis as any)[NAV_WATCHER_SYM] as { stop?: () => void } | undefined;
    if (prev && typeof prev.stop === 'function') {
      try {
        prev.stop();
      } catch (_) {}
    }
    try {
      delete (globalThis as any)[NAV_WATCHER_SYM];
    } catch (_) {}
  }

  clearGlobalNavWatcher();

  function stopNavWatcher(): void {
    if (navListening && typeof window !== 'undefined') {
      window.removeEventListener('popstate', notifyNav);
      window.removeEventListener('hashchange', notifyNav);
      navListening = false;
    }
    if (navInterval) {
      clearInterval(navInterval);
      navInterval = 0;
    }
    const cur = (globalThis as any)[NAV_WATCHER_SYM] as { stop?: () => void } | undefined;
    if (cur?.stop === stopNavWatcher) {
      try {
        delete (globalThis as any)[NAV_WATCHER_SYM];
      } catch (_) {}
    }
  }

  function startNavWatcher(): void {
    if (navListening || navInterval) return;
    clearGlobalNavWatcher();
    lastHref = location.href;
    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', notifyNav);
      window.addEventListener('hashchange', notifyNav);
      navListening = true;
    }
    navInterval = setInterval(notifyNav, 400);
    try {
      (globalThis as any)[NAV_WATCHER_SYM] = { stop: stopNavWatcher };
    } catch (_) {}
  }

  function patchHistory(hist: History | null | undefined): void {
    if (!hist || patchedHistories.has(hist)) return;
    patchedHistories.add(hist);

    let state: HistoryPatchState | undefined;
    try {
      state = (hist as any)[PATCHED_HISTORY_SYM] as HistoryPatchState | undefined;
      if (!state) {
        state = { notify: notifyNav };
        (hist as any)[PATCHED_HISTORY_SYM] = state;
      } else {
        state.notify = notifyNav;
      }
    } catch (_) {
      state = undefined;
    }

    const activeState = state;
    for (const name of ['pushState', 'replaceState'] as const) {
      const orig = hist[name];
      if (typeof orig !== 'function') continue;
      if ((orig as any)[PATCHED_HISTORY_SYM] && activeState) continue;
      try {
        const wrapped = function (this: History, ...args: any[]) {
          const r = (orig as any).apply(this, args);
          if (activeState) activeState.notify();
          else notifyNav();
          return r;
        };
        (wrapped as any)[PATCHED_HISTORY_SYM] = true;
        hist[name] = wrapped;
      } catch (_) {}
    }
  }

  patchHistory(pageWin?.history);
  if (typeof window !== 'undefined' && window.history !== pageWin?.history) {
    patchHistory(window.history);
  }

  function ready(cb: () => void): CleanupFn {
    if (document.body) {
      safe(cb, 'ready');
      return () => {};
    }
    let cancelled = false;
    const onReady = () => {
      if (cancelled) return;
      cancelled = true;
      safe(cb, 'ready');
    };
    document.addEventListener('DOMContentLoaded', onReady, { once: true });
    return () => {
      if (cancelled) return;
      cancelled = true;
      document.removeEventListener('DOMContentLoaded', onReady);
    };
  }

  function combinedOwnSelector(): string {
    if (ownSelectors.size === 0) return BASE_OWN_UI.join(',');
    return [...BASE_OWN_UI, ...ownSelectors.values()].join(',');
  }

  function isOwn(m: MutationRecord): boolean {
    const t = m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement;
    if (!t) return false;
    try {
      return !!t.closest(combinedOwnSelector());
    } catch {
      for (const sel of [...BASE_OWN_UI, ...ownSelectors.values()]) {
        try {
          if (t.closest(sel)) return true;
        } catch {}
      }
      return false;
    }
  }

  function disconnectObserver(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = 0;
    }
    queued = [];
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (readyCancel) {
      readyCancel();
      readyCancel = null;
    }
  }

  function ensureObserver(): void {
    if (bodyCbs.size === 0 || observer) return;
    if (!document.body) {
      if (!readyCancel) {
        readyCancel = ready(() => {
          readyCancel = null;
          ensureObserver();
        });
      }
      return;
    }
    observer = new MutationObserver((records) => {
      for (const record of records) if (!isOwn(record)) queued.push(record);
      if (queued.length && !flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = 0;
          const batch = queued;
          queued = [];
          coreLog.debug(`Flushing mutation batch: ${batch.length} record(s) to ${bodyCbs.size} listener(s)`);
          fire(bodyCbs, batch);
        }, 50);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function registerOwnUi(selector: string): CleanupFn {
    const cleanSel = String(selector || '').trim();
    if (!cleanSel) return () => {};
    let active = true;
    const token = Symbol(cleanSel);
    ownSelectors.set(token, cleanSel);
    return () => {
      if (!active) return;
      active = false;
      ownSelectors.delete(token);
    };
  }

  function onNavigate(cb: () => void): CleanupFn {
    const entry: ObserverEntry<() => void> = { cb, active: true };
    const wasEmpty = navCbs.size === 0;
    navCbs.add(entry);
    if (wasEmpty) startNavWatcher();
    return () => {
      if (!entry.active) return;
      entry.active = false;
      navCbs.delete(entry);
      if (navCbs.size === 0) stopNavWatcher();
    };
  }

  function onBodyMutation(cb: (mutations: MutationRecord[]) => void): CleanupFn {
    const entry: ObserverEntry<(mutations: MutationRecord[]) => void> = { cb, active: true };
    bodyCbs.add(entry);
    ensureObserver();
    return () => {
      if (!entry.active) return;
      entry.active = false;
      bodyCbs.delete(entry);
      if (bodyCbs.size === 0) disconnectObserver();
    };
  }

  const INVALID_SELECTOR = Symbol('invalidSelector');

  function safeQuerySelector<T extends HTMLElement>(selector: string): T | null | typeof INVALID_SELECTOR {
    try {
      return document.querySelector<T>(selector);
    } catch {
      return INVALID_SELECTOR;
    }
  }

  function waitForSelector<T extends HTMLElement = HTMLElement>(
    selector: string,
    timeoutMs = 8000,
    signal?: AbortSignal
  ): Promise<T | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const existing = safeQuerySelector<T>(selector);
    if (existing === INVALID_SELECTOR) return Promise.resolve(null);
    if (existing) return Promise.resolve(existing);
    if (!(timeoutMs > 0)) return Promise.resolve(null);

    return new Promise((resolve) => {
      let done = false;
      let unsub: CleanupFn | null = null;
      let readyUnsub: CleanupFn | null = null;
      let onAbort: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (v: T | null) => {
        if (done) return;
        done = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
        if (readyUnsub) {
          readyUnsub();
          readyUnsub = null;
        }
        if (unsub) {
          unsub();
          unsub = null;
        }
        resolve(v);
      };

      const checkSelector = () => {
        const el = safeQuerySelector<T>(selector);
        if (el === INVALID_SELECTOR) finish(null);
        else if (el) finish(el);
      };

      if (signal) {
        onAbort = () => finish(null);
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => finish(null), Math.min(timeoutMs, 0x7fffffff));
      }
      unsub = onBodyMutation(checkSelector);
      if (!done && !document.body) {
        readyUnsub = ready(() => {
          readyUnsub = null;
          checkSelector();
        });
      }
    });
  }

  function silently(fn: () => void): void {
    muteDepth++;
    try {
      fn();
    } finally {
      muteDepth = Math.max(0, muteDepth - 1);
      if (muteDepth === 0) {
        lastHref = location.href;
      }
    }
  }

  return {
    onNavigate,
    onBodyMutation,
    waitForSelector,
    ready,
    silently,
    registerOwnUi
  };
})();
