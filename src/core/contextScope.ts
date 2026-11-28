import { addStyle } from './styles';
import { createDeadModalHandle, createModal, openAlertModal, openConfirmModal } from './modal';
import { Core } from './observer';
import { createCleanupTracker, drainCleanupsReverse } from './scopeLifecycle';
import { composeAbortSignals, isGqlMutation } from '../utils/helpers';
import type {
  AddStyleFn,
  AlertOptions,
  AniListClient,
  CleanupFn,
  ConfirmOptions,
  CssSource,
  DebouncedFn,
  ModalHandle,
  ModalOptions,
  QueryOptions
} from '../types';

export { drainCleanupsReverse };

const noop: CleanupFn = () => {};

export interface ContextScopeCounters {
  idSeq: number;
  styleSeq: number;
  modalSeq: number;
}

export interface ContextScopeOptions {
  /** Prefix placed after `ala-` for generated element, style, and modal IDs. */
  prefix: string;
  /** Lifetime signal; scope helpers become no-ops once aborted. */
  signal: AbortSignal;
  /** Optional external closed/tearing-down predicate checked alongside `signal.aborted`. */
  isClosed?: () => boolean;
  /** Cleanup set to populate and drain; defaults to a fresh `Set<CleanupFn>()`. */
  cleanups?: Set<CleanupFn>;
  /** Auto-style ID segment (`'style'` or `'route-style'`). Defaults to `'style'`. */
  styleKind?: 'style' | 'route-style';
  /** Optional shared sequence counters across parent and child scopes. */
  counters?: ContextScopeCounters;
  /** Optional error callback invoked when a cleanup throws. */
  onError?: (err: unknown) => void;
  /** Invoked before opening a modal through `scope.modal()`. */
  onModalStart?: () => void;
  /** Invoked if `createModal` returned a dead/unmounted handle without calling `onClose`. */
  onModalAbort?: () => void;
  /** Invoked after a modal's `onClose` callback runs. */
  onModalClose?: () => void;
}

export interface ContextScope {
  readonly signal: AbortSignal;
  readonly cleanups: Set<CleanupFn>;
  readonly isClosed: () => boolean;
  track: <T extends CleanupFn>(fn: T) => T;
  whenAlive: (fn: () => CleanupFn) => CleanupFn;
  onCleanup: (fn: CleanupFn) => void;
  dispose: () => void;
  getId: (name?: string) => string;
  addStyle: AddStyleFn;
  listen: (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => CleanupFn;
  interval: (fn: () => void, ms: number) => CleanupFn;
  timeout: (fn: () => void, ms: number) => CleanupFn;
  debounce: <T extends (...args: any[]) => void>(fn: T, ms?: number) => DebouncedFn<T>;
  raf: (fn: FrameRequestCallback) => CleanupFn;
  observe: (
    target: Node | null | undefined,
    options: MutationObserverInit,
    cb: MutationCallback
  ) => CleanupFn;
  modal: (opts: ModalOptions) => ModalHandle;
  confirm: (opts: string | ConfirmOptions) => Promise<boolean>;
  alert: (opts: string | AlertOptions) => Promise<void>;
  waitForSelector: <T extends HTMLElement = HTMLElement>(selector: string, timeoutMs?: number) => Promise<T | null>;
}

/**
 * Creates a lifecycle-scoped resource helper factory backed by a self-pruning `Set<CleanupFn>`.
 */
export function createContextScope(opts: ContextScopeOptions): ContextScope {
  const {
    prefix,
    signal,
    isClosed: externalClosed,
    cleanups: initialCleanups,
    styleKind = 'style',
    counters = { idSeq: 0, styleSeq: 0, modalSeq: 0 },
    onError,
    onModalStart,
    onModalAbort,
    onModalClose
  } = opts;

  const lifecycle = createCleanupTracker({
    prefix,
    signal,
    isClosed: externalClosed,
    cleanups: initialCleanups,
    onError
  });
  const cleanups = lifecycle.cleanups;
  const checkClosed = lifecycle.isClosed;
  const track = lifecycle.track;

  const whenAlive = (fn: () => CleanupFn): CleanupFn => {
    if (checkClosed()) return noop;
    return track(fn());
  };

  const onCleanup = (fn: CleanupFn): void => {
    track(fn);
  };

  const getId = (name?: string): string => {
    const trimmed = name?.trim();
    if (!trimmed) return `ala-${prefix}-${++counters.idSeq}`;
    return trimmed.startsWith('ala-') ? trimmed : `ala-${prefix}-${trimmed}`;
  };

  const scopedAddStyle: AddStyleFn = (idOrCss: CssSource, maybeCss?: CssSource): CleanupFn => {
    if (checkClosed()) return noop;
    const isOneArg = maybeCss === undefined;
    const css = isOneArg ? idOrCss : maybeCss;
    let styleId: string;
    if (isOneArg) {
      styleId = `ala-${prefix}-${styleKind}-${++counters.styleSeq}`;
    } else {
      const raw = String(idOrCss || '').trim();
      if (!raw) {
        styleId = `ala-${prefix}-${styleKind}-${++counters.styleSeq}`;
      } else if (raw.startsWith('ala-')) {
        styleId = raw;
      } else {
        styleId = `ala-${prefix}-${raw}${raw.endsWith('-style') ? '' : '-style'}`;
      }
    }
    return track(addStyle(styleId, css));
  };

  const debounce = <T extends (...args: any[]) => void>(fn: T, ms = 0): DebouncedFn<T> => {
    let timerId: ReturnType<typeof setTimeout> | 0 = 0;
    let pendingArgs: Parameters<T> | null = null;
    let trackedCancel: CleanupFn | null = null;

    const cancel = (): void => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = 0;
      }
      pendingArgs = null;
      if (trackedCancel) {
        cleanups.delete(trackedCancel);
        trackedCancel = null;
      }
    };

    const flush = (): void => {
      if (!pendingArgs || checkClosed()) {
        cancel();
        return;
      }
      const args = pendingArgs;
      cancel();
      fn(...args);
    };

    const debounced = ((...args: Parameters<T>): void => {
      if (checkClosed()) {
        cancel();
        return;
      }
      if (timerId) {
        clearTimeout(timerId);
        timerId = 0;
      }
      pendingArgs = args;
      if (!trackedCancel) {
        trackedCancel = () => cancel();
        cleanups.add(trackedCancel);
      }
      timerId = setTimeout(() => {
        timerId = 0;
        const argsToRun = pendingArgs;
        pendingArgs = null;
        if (trackedCancel) {
          cleanups.delete(trackedCancel);
          trackedCancel = null;
        }
        if (argsToRun && !checkClosed()) {
          fn(...argsToRun);
        }
      }, ms);
    }) as DebouncedFn<T>;

    debounced.cancel = cancel;
    debounced.flush = flush;
    return debounced;
  };

  const raf = (fn: FrameRequestCallback): CleanupFn => {
    if (checkClosed()) return noop;
    const hasRaf = typeof requestAnimationFrame === 'function';
    const hasCancelRaf = typeof cancelAnimationFrame === 'function';
    if (!hasRaf) {
      let fired = false;
      let cancelTracked: CleanupFn = noop;
      const timerId = setTimeout(() => {
        fired = true;
        if (cancelTracked !== noop) cleanups.delete(cancelTracked);
        if (!checkClosed()) fn(typeof performance !== 'undefined' ? performance.now() : Date.now());
      }, 16);
      if (fired) return noop;
      cancelTracked = track(() => clearTimeout(timerId));
      return cancelTracked;
    }
    let fired = false;
    let cancelTracked: CleanupFn = noop;
    const frameId = requestAnimationFrame((ts) => {
      fired = true;
      if (cancelTracked !== noop) cleanups.delete(cancelTracked);
      if (!checkClosed()) fn(ts);
    });
    if (fired) return noop;
    cancelTracked = track(() => {
      if (hasCancelRaf) cancelAnimationFrame(frameId);
    });
    return cancelTracked;
  };

  const interval = (fn: () => void, ms: number): CleanupFn => {
    if (checkClosed()) return noop;
    const id = setInterval(() => {
      if (!checkClosed()) fn();
    }, ms);
    return track(() => clearInterval(id));
  };

  const observe = (
    target: Node | null | undefined,
    options: MutationObserverInit,
    cb: MutationCallback
  ): CleanupFn => {
    if (checkClosed() || !target || typeof MutationObserver !== 'function') return noop;
    const observer = new MutationObserver((mutations, obs) => {
      if (checkClosed()) return;
      cb(mutations, obs);
    });
    observer.observe(target, options);
    return track(() => observer.disconnect());
  };

  const modal = (modalOpts: ModalOptions): ModalHandle => {
    const modalId = getId(modalOpts.id?.trim() || `modal-${++counters.modalSeq}`);
    if (checkClosed()) {
      return createDeadModalHandle(modalId, onError);
    }
    let onCloseFired = false;
    let untracked = false;
    let removeTracked: CleanupFn = noop;
    onModalStart?.();
    let handle: ModalHandle;
    try {
      handle = createModal({
        ...modalOpts,
        id: modalId,
        onClose: () => {
          onCloseFired = true;
          if (!untracked) {
            untracked = true;
            removeTracked();
          }
          try {
            modalOpts.onClose?.();
          } finally {
            onModalClose?.();
          }
        }
      });
    } catch (err) {
      if (!onCloseFired) onModalAbort?.();
      throw err;
    }
    if (!onCloseFired && !handle.backdrop.isConnected) {
      onModalAbort?.();
      return handle;
    }
    if (!untracked && handle.backdrop.isConnected) {
      const trackedClose = track(handle.close);
      removeTracked = () => cleanups.delete(trackedClose);
      return {
        ...handle,
        close: trackedClose
      };
    }
    return handle;
  };

  const confirm = (confirmOpts: string | ConfirmOptions): Promise<boolean> => {
    if (checkClosed()) return Promise.resolve(false);
    return openConfirmModal(confirmOpts, modal);
  };

  const alert = (alertOpts: string | AlertOptions): Promise<void> => {
    if (checkClosed()) return Promise.resolve(undefined);
    return openAlertModal(alertOpts, modal);
  };

  const waitForSelector = <T extends HTMLElement = HTMLElement>(
    selector: string,
    timeoutMs = 8000
  ): Promise<T | null> => {
    if (checkClosed()) return Promise.resolve(null);
    return Core.waitForSelector<T>(selector, timeoutMs, signal);
  };

  return {
    signal,
    cleanups,
    isClosed: checkClosed,
    track,
    whenAlive,
    onCleanup,
    dispose: lifecycle.dispose,
    getId,
    addStyle: scopedAddStyle,
    listen: lifecycle.listen,
    interval,
    timeout: lifecycle.timeout,
    debounce,
    raf,
    observe,
    modal,
    confirm,
    alert,
    waitForSelector
  };
}

/**
 * Wraps an AniListClient so queries and reads abort with `scopeSignal`, post-teardown mutations reject,
 * cache/viewer invalidations become no-ops once closed, and `hasAuth()` stays non-reconciling when closed.
 */
export function scopeAniListClient(
  getClient: () => AniListClient,
  scopeSignal: AbortSignal,
  isClosed: () => boolean
): Omit<AniListClient, 'session'> {
  const withScopeSignal = <T>(
    callerSignal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    if (!callerSignal || callerSignal === scopeSignal) {
      return run(scopeSignal);
    }
    const composed = composeAbortSignals(scopeSignal, callerSignal);
    let promise: Promise<T>;
    try {
      promise = run(composed.signal);
    } catch (err) {
      composed.dispose();
      return Promise.reject(err);
    }
    return composed.dispose === noop ? promise : promise.finally(composed.dispose);
  };

  return {
    query: (q, variables, optionsOrRetries) => {
      if (isClosed() && isGqlMutation(q)) {
        return Promise.reject(new Error('Context disposed'));
      }
      const baseOpts: QueryOptions =
        typeof optionsOrRetries === 'number'
          ? { retries: optionsOrRetries }
          : optionsOrRetries || {};
      return withScopeSignal(baseOpts.signal, (signal) =>
        getClient().query(q, variables, { ...baseOpts, signal })
      );
    },
    getMediaList: (target, type, options) =>
      withScopeSignal(options?.signal, (signal) =>
        getClient().getMediaList(target, type, { ...options, signal })
      ),
    viewer: (forceFresh, opts) =>
      withScopeSignal(opts?.signal, (signal) =>
        getClient().viewer(forceFresh, { ...opts, signal })
      ),
    clearViewer: () => {
      if (!isClosed()) getClient().clearViewer();
    },
    invalidate: (...args) => {
      if (!isClosed()) getClient().invalidate(...args);
    },
    invalidateMediaList: (...args) => {
      if (!isClosed()) getClient().invalidateMediaList(...args);
    },
    hasAuth: (opts) =>
      getClient().hasAuth(isClosed() ? { ...opts, reconcile: false } : opts),
    resumeAt: () => getClient().resumeAt(),
    media: {
      get: (id, type, opts) =>
        withScopeSignal(opts?.signal, (signal) =>
          getClient().media.get(id, type, { ...opts, signal })
        ),
      save: (id, type, patch, opts) => {
        if (isClosed()) {
          return Promise.reject(new Error('Context disposed'));
        }
        return withScopeSignal(opts?.signal, (signal) =>
          getClient().media.save(id, type, patch, { ...opts, signal })
        );
      }
    }
  };
}
