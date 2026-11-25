import { addStyle, prefixAlaId } from './styles';
import { Core } from './observer';
import { esc } from '../utils/helpers';
import type { CleanupFn, ModalHandle, ModalOptions } from '../types';

export type { ModalOptions, ModalHandle };

let fallbackSeq = 0;

const MODAL_STYLE_ID = 'ala-core-modal-style';
const MODAL_CSS = `
  .ala-core-backdrop{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:rgba(5,12,20,.72);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
  .ala-core-sheet{display:flex;flex-direction:column;width:100%;max-height:92vh;border-radius:10px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));box-shadow:0 18px 60px rgba(0,0,0,.5);overflow:hidden}
  .ala-core-sheet *{box-sizing:border-box}
  .ala-core-sheet :focus-visible{outline:2px solid rgb(var(--color-blue));outline-offset:2px}
  .ala-core-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(var(--color-text-lighter),.14)}
  .ala-core-head h2{margin:0;font-size:18px;font-weight:600}
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
  const modalId = opts.id ? prefixAlaId(opts.id) || `ala-modal-${++fallbackSeq}` : `ala-modal-${++fallbackSeq}`;
  const disposeStyle = addStyle(MODAL_STYLE_ID, MODAL_CSS);
  const disposeOwn = Core.registerOwnUi(`#${modalId}`);
  document.getElementById(modalId)?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = modalId;
  backdrop.className = 'ala-core-backdrop';
  const titleId = `${modalId}-title`;
  backdrop.innerHTML = `
    <div class="ala-core-sheet" style="max-width:${esc(opts.maxWidth || '640px')}" role="dialog" aria-modal="true" aria-labelledby="${esc(titleId)}">
      <header class="ala-core-head">
        <h2 id="${esc(titleId)}">${esc(opts.title)}</h2>
        <button class="ala-icon-btn ala-core-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="ala-core-body">${opts.bodyHtml || ''}</div>
      <footer class="ala-core-foot">${opts.footerHtml || ''}</footer>
    </div>
  `;

  let closed = false;
  const cleanups: CleanupFn[] = [disposeStyle, disposeOwn];

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    for (const fn of cleanups) {
      try {
        fn();
      } catch {}
    }
    opts.onClose?.();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  document.addEventListener('keydown', onKey, true);
  backdrop.querySelector('.ala-core-close')?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  document.body.appendChild(backdrop);

  return {
    backdrop,
    sheet: backdrop.querySelector('.ala-core-sheet') as HTMLElement,
    body: backdrop.querySelector('.ala-core-body') as HTMLElement,
    footer: backdrop.querySelector('.ala-core-foot') as HTMLElement,
    close
  };
}
