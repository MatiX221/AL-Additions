import { addStyle, prefixAlaId } from './styles';
import { Core } from './observer';
import { createCleanupTracker } from './scopeLifecycle';
import { createCoreLogger, esc } from '../utils/helpers';
import type { AlertOptions, CleanupFn, ConfirmOptions, ModalHandle, ModalOptions } from '../types';

export type { ModalOptions, ModalHandle, ConfirmOptions, AlertOptions };

const modalLog = createCoreLogger('core');
const noop: CleanupFn = () => {};

let fallbackSeq = 0;
const activeModals = new Map<string, () => void>();
const modalStack: Array<{ close: () => void }> = [];
let scrollLockCount = 0;
let savedOverflow: string | null = null;

export function hasActiveModal(): boolean {
  return modalStack.length > 0;
}

/** Acquires a ref-counted document scroll lock and returns an idempotent release function. */
export function acquireScrollLock(): CleanupFn {
  if (scrollLockCount === 0 && typeof document !== 'undefined' && document.documentElement) {
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  }
  scrollLockCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (scrollLockCount > 0) {
      scrollLockCount--;
      if (scrollLockCount === 0) {
        if (savedOverflow !== null && typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.style.overflow = savedOverflow;
        }
        savedOverflow = null;
      }
    }
  };
}

/** Registers a modal overlay on the shared LIFO Escape stack for top-of-stack coordination. */
export function registerModalOverlay(onEscape: () => void): { isTop: () => boolean; dispose: CleanupFn } {
  const entry = { close: onEscape };
  modalStack.push(entry);
  let disposed = false;
  return {
    isTop: () => !disposed && modalStack[modalStack.length - 1] === entry,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const idx = modalStack.indexOf(entry);
      if (idx !== -1) {
        modalStack.splice(idx, 1);
      }
    }
  };
}

/** Creates an inert already-closed ModalHandle when a modal cannot be mounted. */
export function createDeadModalHandle(id: string, onError?: (err: unknown) => void): ModalHandle {
  const dead = document.createElement('div');
  const ac = new AbortController();
  ac.abort();
  return {
    id,
    selector: `#${id}`,
    signal: ac.signal,
    backdrop: dead,
    sheet: dead,
    body: dead,
    footer: dead,
    close: noop,
    listen: () => noop,
    timeout: () => noop,
    onCleanup: (fn) => {
      try {
        fn();
      } catch (err) {
        if (onError) onError(err);
        else modalLog.error(`Modal "${id}" cleanup failed:`, err);
      }
    }
  };
}

const MODAL_STYLE_ID = 'ala-core-modal-style';
const MODAL_CSS = `
  .ala-core-backdrop{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:rgba(5,12,20,.72);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
  .ala-core-sheet{display:flex;flex-direction:column;width:100%;max-height:92vh;border-radius:10px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));box-shadow:0 18px 60px rgba(0,0,0,.5);overflow:hidden}
  .ala-core-sheet *{box-sizing:border-box}
  .ala-core-sheet :focus-visible{outline:2px solid rgb(var(--color-blue));outline-offset:2px}
  .ala-core-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(var(--color-text-lighter),.14)}
  .ala-core-head-text{min-width:0}
  .ala-core-head h2{margin:0;font-size:18px;font-weight:600}
  .ala-core-subtitle{margin-top:2px;font-size:12px;color:rgb(var(--color-text-lighter));line-height:1.4}
  .ala-core-body{flex:1 1 auto;min-height:0;padding:16px 20px;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-gutter:stable}
  .ala-core-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 20px;border-top:1px solid rgba(var(--color-text-lighter),.14)}
  .ala-core-sheet .ala-btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 18px;border:1px solid rgba(var(--color-text-lighter),.25);border-radius:4px;background:transparent;color:rgb(var(--color-text));font:inherit;font-size:13px;cursor:pointer}
  .ala-core-sheet .ala-btn--primary{border-color:transparent;background:rgb(var(--color-blue));color:#fff;font-weight:600}
  .ala-core-sheet .ala-btn--danger{border-color:rgba(var(--color-red,224,85,85),.35);color:rgb(var(--color-red,224,85,85))}
  .ala-core-sheet .ala-btn--danger:hover{border-color:transparent;background:rgb(var(--color-red,224,85,85));color:#fff}
  .ala-core-sheet .ala-btn--sm{min-height:32px;padding:0 12px;font-size:12px}
  .ala-core-sheet .ala-btn:hover:not(:disabled){filter:brightness(1.1)}
  .ala-core-sheet .ala-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:36px;height:36px;border:0;border-radius:50%;background:transparent;color:rgb(var(--color-text-lighter));cursor:pointer}
  .ala-core-sheet .ala-icon-btn:hover{background:rgba(var(--color-text-lighter),.14);color:rgb(var(--color-text))}
`;

export function createModal(opts: ModalOptions): ModalHandle {
  const modalId = prefixAlaId(opts.id?.trim() || `modal-${++fallbackSeq}`);
  const selector = `#${modalId}`;
  const existingClose = activeModals.get(modalId);
  if (existingClose) {
    existingClose();
  }
  if (!document.body) {
    return createDeadModalHandle(modalId);
  }

  const modalAc = new AbortController();
  let closed = false;
  const lifecycle = createCleanupTracker({
    prefix: modalId,
    signal: modalAc.signal,
    isClosed: () => closed,
    onError: (err) => modalLog.error(`Modal "${modalId}" cleanup failed:`, err)
  });
  const trackModal = lifecycle.track;

  let backdrop: HTMLDivElement | null = null;
  let onKeyRef: ((e: KeyboardEvent) => void) | null = null;
  let overlayHandle: { isTop: () => boolean; dispose: CleanupFn } | null = null;
  let releaseScrollLock: CleanupFn | null = null;
  let closeRef: (() => void) | null = null;

  const cleanupResources = () => {
    if (onKeyRef) {
      document.removeEventListener('keydown', onKeyRef, true);
      onKeyRef = null;
    }
    if (closeRef && activeModals.get(modalId) === closeRef) {
      activeModals.delete(modalId);
    }
    if (overlayHandle) {
      const handle = overlayHandle;
      overlayHandle = null;
      handle.dispose();
    }
    if (releaseScrollLock) {
      const release = releaseScrollLock;
      releaseScrollLock = null;
      release();
    }
    backdrop?.remove();
    lifecycle.dispose();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    modalAc.abort();
    cleanupResources();
    opts.onClose?.();
  };
  closeRef = close;

  try {
    trackModal(addStyle(MODAL_STYLE_ID, MODAL_CSS));
    if (opts.style !== undefined) {
      const styleSource = opts.style;
      trackModal(
        addStyle(
          `${modalId}-style`,
          typeof styleSource === 'function' ? () => styleSource(selector) : styleSource
        )
      );
    }
    trackModal(Core.registerOwnUi(selector));
    document.getElementById(modalId)?.remove();

    backdrop = document.createElement('div');
    backdrop.id = modalId;
    backdrop.className = 'ala-core-backdrop';
    const titleId = `${modalId}-title`;
    const titleHtml = opts.subtitle
      ? `<div class="ala-core-head-text"><h2 id="${esc(titleId)}">${esc(opts.title)}</h2><div class="ala-core-subtitle">${esc(opts.subtitle)}</div></div>`
      : `<h2 id="${esc(titleId)}">${esc(opts.title)}</h2>`;
    backdrop.innerHTML = `
    <div class="ala-core-sheet" style="max-width:${esc(opts.maxWidth || '640px')}" role="dialog" aria-modal="true" aria-labelledby="${esc(titleId)}">
      <header class="ala-core-head">
        ${titleHtml}
        <button class="ala-icon-btn ala-core-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="ala-core-body">${opts.bodyHtml || ''}</div>
      <footer class="ala-core-foot">${opts.footerHtml || ''}</footer>
    </div>
  `;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!overlayHandle?.isTop()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    onKeyRef = onKey;

    activeModals.set(modalId, close);
    overlayHandle = registerModalOverlay(close);
    releaseScrollLock = acquireScrollLock();

    document.addEventListener('keydown', onKey, true);
    backdrop.querySelector('.ala-core-close')?.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        close();
        return;
      }
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      const closeTrigger = target?.closest('[data-ala-close]');
      if (closeTrigger && backdrop!.contains(closeTrigger) && !(closeTrigger as HTMLButtonElement).disabled) {
        close();
      }
    });

    document.body.appendChild(backdrop);
  } catch (err) {
    closed = true;
    modalAc.abort();
    cleanupResources();
    throw err;
  }

  const onCleanup = (fn: CleanupFn): void => {
    trackModal(fn);
  };

  return {
    id: modalId,
    selector,
    signal: modalAc.signal,
    backdrop,
    sheet: backdrop.querySelector('.ala-core-sheet') as HTMLElement,
    body: backdrop.querySelector('.ala-core-body') as HTMLElement,
    footer: backdrop.querySelector('.ala-core-foot') as HTMLElement,
    close,
    listen: lifecycle.listen,
    timeout: lifecycle.timeout,
    onCleanup
  };
}

function bindModalAbortSignal(
  handle: ModalHandle,
  signal: AbortSignal | undefined,
  onSettled: () => void
): boolean {
  if (!signal) return false;
  const onAbort = () => {
    try {
      handle.close();
    } finally {
      onSettled();
    }
  };
  if (signal.aborted) {
    onAbort();
    return true;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  handle.onCleanup(() => signal.removeEventListener('abort', onAbort));
  return false;
}

/** Opens a stacked, non-blocking confirmation dialog resolving to `true` only on confirm. */
export function openConfirmModal(
  opts: string | ConfirmOptions,
  modalFactory: (modalOpts: ModalOptions) => ModalHandle = createModal
): Promise<boolean> {
  const normalized: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts;
  const signal = normalized.signal;
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  const title = normalized.title?.trim() || 'Confirm';
  const confirmText = normalized.confirmText?.trim() || 'Confirm';
  const cancelText = normalized.cancelText?.trim() || 'Cancel';
  const maxWidth = normalized.maxWidth || '420px';

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let confirmed = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let handle: ModalHandle;
    try {
      handle = modalFactory({
        id: normalized.id,
        title,
        subtitle: normalized.subtitle,
        maxWidth,
        bodyHtml: `<p class="ala-core-dialog-msg" style="margin:0;white-space:pre-line;line-height:1.5">${esc(normalized.message)}</p>`,
        footerHtml: `<button type="button" class="ala-btn ala-core-confirm-cancel" data-ala-close>${esc(cancelText)}</button><button type="button" class="ala-btn ${normalized.danger ? 'ala-btn--danger' : 'ala-btn--primary'} ala-core-confirm-ok">${esc(confirmText)}</button>`,
        onClose: () => finish(confirmed)
      });
    } catch {
      finish(false);
      return;
    }

    if (!handle.backdrop.isConnected || handle.signal.aborted) {
      finish(false);
      return;
    }

    if (bindModalAbortSignal(handle, signal, () => finish(false))) {
      return;
    }

    const okBtn = handle.footer.querySelector<HTMLButtonElement>('.ala-core-confirm-ok');
    const cancelBtn = handle.footer.querySelector<HTMLButtonElement>('.ala-core-confirm-cancel');
    if (okBtn) {
      handle.listen(okBtn, 'click', () => {
        confirmed = true;
        try {
          handle.close();
        } finally {
          finish(true);
        }
      });
    }
    (normalized.danger ? cancelBtn : okBtn)?.focus?.();
  });
}

/** Opens a stacked, non-blocking alert dialog resolving when acknowledged or dismissed. */
export function openAlertModal(
  opts: string | AlertOptions,
  modalFactory: (modalOpts: ModalOptions) => ModalHandle = createModal
): Promise<void> {
  const normalized: AlertOptions = typeof opts === 'string' ? { message: opts } : opts;
  const signal = normalized.signal;
  if (signal?.aborted) {
    return Promise.resolve(undefined);
  }
  const title = normalized.title?.trim() || 'Notice';
  const okText = normalized.okText?.trim() || 'OK';
  const maxWidth = normalized.maxWidth || '420px';

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    };

    let handle: ModalHandle;
    try {
      handle = modalFactory({
        id: normalized.id,
        title,
        subtitle: normalized.subtitle,
        maxWidth,
        bodyHtml: `<p class="ala-core-dialog-msg" style="margin:0;white-space:pre-line;line-height:1.5">${esc(normalized.message)}</p>`,
        footerHtml: `<button type="button" class="ala-btn ala-btn--primary ala-core-alert-ok" data-ala-close>${esc(okText)}</button>`,
        onClose: finish
      });
    } catch {
      finish();
      return;
    }

    if (!handle.backdrop.isConnected || handle.signal.aborted) {
      finish();
      return;
    }

    if (bindModalAbortSignal(handle, signal, finish)) {
      return;
    }

    handle.footer.querySelector<HTMLButtonElement>('.ala-core-alert-ok')?.focus?.();
  });
}
