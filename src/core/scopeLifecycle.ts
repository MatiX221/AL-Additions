import { createCoreLogger } from '../utils/helpers';
import type { CleanupFn } from '../types';

const scopeLog = createCoreLogger('core');
const MAX_CLEANUP_ITERATIONS = 10_000;
const noop: CleanupFn = () => {};

export interface CleanupTrackerOptions {
  /** Label / prefix used in diagnostic logs. */
  prefix: string;
  /** Lifetime signal; tracker helpers become no-ops once aborted. */
  signal: AbortSignal;
  /** Optional external closed/tearing-down predicate checked alongside `signal.aborted`. */
  isClosed?: () => boolean;
  /** Cleanup set to populate and drain; defaults to a fresh `Set<CleanupFn>()`. */
  cleanups?: Set<CleanupFn>;
  /** Optional error callback invoked when a cleanup throws. */
  onError?: (err: unknown) => void;
}

export interface CleanupTracker {
  readonly cleanups: Set<CleanupFn>;
  readonly isClosed: () => boolean;
  track: <T extends CleanupFn>(fn: T) => T;
  listen: (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => CleanupFn;
  timeout: (fn: () => void, ms: number) => CleanupFn;
  dispose: () => void;
}

/**
 * Drains a cleanup `Set<CleanupFn>` in reverse insertion order with re-entrant
 * teardown-time cleanup support and an upper iteration bound.
 */
export function drainCleanupsReverse(
  label: string,
  cleanups: Set<CleanupFn>,
  onError?: (err: unknown) => void
): void {
  let iterations = 0;
  while (cleanups.size > 0) {
    const batch = [...cleanups];
    for (let i = batch.length - 1; i >= 0; i--) {
      if (++iterations > MAX_CLEANUP_ITERATIONS) {
        const msg = `Scope "${label}" exceeded max cleanup iterations (${MAX_CLEANUP_ITERATIONS}); aborting teardown.`;
        if (onError) onError(new Error(msg));
        else scopeLog.error(msg);
        cleanups.clear();
        return;
      }
      const fn = batch[i];
      if (!cleanups.has(fn)) continue;
      cleanups.delete(fn);
      try {
        fn();
      } catch (err) {
        if (onError) onError(err);
        else scopeLog.error(`Scope "${label}" failed during cleanup:`, err);
      }
    }
  }
}

/**
 * Creates a lifecycle-scoped cleanup tracker supporting reverse teardown,
 * closed-guarded event listeners, and self-pruning timeouts.
 */
export function createCleanupTracker(opts: CleanupTrackerOptions): CleanupTracker {
  const {
    prefix,
    signal,
    isClosed: externalClosed,
    cleanups = new Set<CleanupFn>(),
    onError
  } = opts;

  const checkClosed = (): boolean => signal.aborted || Boolean(externalClosed?.());

  const reportError = (err: unknown): void => {
    if (onError) onError(err);
    else scopeLog.error(`Scope "${prefix}" failed during cleanup:`, err);
  };

  const track = <T extends CleanupFn>(fn: T): T => {
    if (checkClosed()) {
      try {
        fn();
      } catch (err) {
        reportError(err);
      }
      return fn;
    }
    let ran = false;
    const wrapped = (() => {
      if (ran) return;
      ran = true;
      cleanups.delete(wrapped);
      fn();
    }) as T;
    cleanups.add(wrapped);
    return wrapped;
  };

  const listen = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): CleanupFn => {
    if (checkClosed()) return noop;
    const isOnce = typeof options === 'object' && options !== null && Boolean(options.once);
    let trackedRemove: CleanupFn = noop;
    const wrappedListener: EventListener = (ev) => {
      if (isOnce && trackedRemove !== noop) cleanups.delete(trackedRemove);
      if (checkClosed()) return;
      if (typeof listener === 'function') listener.call(target, ev);
      else listener.handleEvent(ev);
    };
    target.addEventListener(type, wrappedListener, options);
    trackedRemove = track(() => target.removeEventListener(type, wrappedListener, options));
    return trackedRemove;
  };

  const timeout = (fn: () => void, ms: number): CleanupFn => {
    if (checkClosed()) return noop;
    let fired = false;
    let cancelTracked: CleanupFn = noop;
    const id = setTimeout(() => {
      fired = true;
      if (cancelTracked !== noop) cleanups.delete(cancelTracked);
      if (!checkClosed()) fn();
    }, ms);
    if (fired) return noop;
    cancelTracked = track(() => clearTimeout(id));
    return cancelTracked;
  };

  const dispose = (): void => {
    drainCleanupsReverse(prefix, cleanups, onError);
  };

  return {
    cleanups,
    isClosed: checkClosed,
    track,
    listen,
    timeout,
    dispose
  };
}
