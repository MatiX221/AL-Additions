import { addStyle } from './styles';
import { Core } from './observer';
import { esc } from '../utils/helpers';
import type { CleanupFn } from '../types';

export interface ModalOptions {
  id: string;
  title: string;
  maxWidth?: string;
  bodyHtml?: string;
  footerHtml?: string;
  onClose?: () => void;
}

export interface ModalHandle {
  backdrop: HTMLDivElement;
  sheet: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  close: () => void;
}

const MODAL_STYLE_ID = 'ala-core-modal-style';
const MODAL_CSS = `
  .ala-core-backdrop{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:rgba(5,12,20,.72);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
  .ala-core-sheet{display:flex;flex-direction:column;width:100%;max-height:92vh;border-radius:10px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));box-shadow:0 18px 60px rgba(0,0,0,.5);overflow:hidden}
  .ala-core-sheet *{box-sizing:border-box}
  .ala-core-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(var(--color-text-lighter),.14)}
  .ala-core-head h2{margin:0;font-size:18px;font-weight:600}
  .ala-core-body{flex:1 1 auto;min-height:0;padding:16px 20px;overflow-y:auto;overflow-x:hidden}
  .ala-core-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 20px;border-top:1px solid rgba(var(--color-text-lighter),.14)}
`;

export function createModal(opts: ModalOptions): ModalHandle {
  const disposeStyle = addStyle(MODAL_STYLE_ID, MODAL_CSS);
  const disposeOwn = Core.registerOwnUi(`#${opts.id}`);
  document.getElementById(opts.id)?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = opts.id;
  backdrop.className = 'ala-core-backdrop';
  const titleId = `${opts.id}-title`;
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
