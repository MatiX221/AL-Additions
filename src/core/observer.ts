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
  let muted = false;
  const pageWin = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window;
  let queued: MutationRecord[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | 0 = 0;

  const fire = <T extends (...args: any[]) => void>(set: Set<ObserverEntry<T>>, ...args: Parameters<T>): void => {
    for (const entry of [...set]) {
      if (!entry.active) continue;
      safe(() => entry.cb(...args), 'core');
    }
  };

  function notifyNav(): void {
    if (muted || location.href === lastHref) return;
    lastHref = location.href;
    coreLog.debug('Navigation detected:', location.pathname + location.search);
    fire(navCbs);
  }

  for (const name of ['pushState', 'replaceState'] as const) {
    const orig = pageWin.history[name];
    try {
      pageWin.history[name] = function (this: History, ...args: any[]) {
        const r = (orig as any).apply(this, args);
        notifyNav();
        return r;
      };
    } catch (_) {}
  }

  window.addEventListener('popstate', notifyNav);
  window.addEventListener('hashchange', notifyNav);
  setInterval(notifyNav, 400);

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
    navCbs.add(entry);
    return () => {
      if (!entry.active) return;
      entry.active = false;
      navCbs.delete(entry);
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

  function waitForSelector<T extends HTMLElement = HTMLElement>(
    selector: string,
    timeoutMs = 8000,
    signal?: AbortSignal
  ): Promise<T | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const existing = document.querySelector<T>(selector);
      if (existing) return resolve(existing);

      let done = false;
      let unsub: CleanupFn | null = null;
      let onAbort: (() => void) | null = null;

      const finish = (v: T | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
        if (unsub) unsub();
        resolve(v);
      };

      if (signal) {
        onAbort = () => finish(null);
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => finish(null), timeoutMs);
      unsub = onBodyMutation(() => {
        const el = document.querySelector<T>(selector);
        if (el) finish(el);
      });
    });
  }

  function silently(fn: () => void): void {
    muted = true;
    try {
      fn();
    } finally {
      muted = false;
      lastHref = location.href;
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
