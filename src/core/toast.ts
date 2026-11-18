import { Core } from './observer';
import { safe } from '../utils/helpers';

export interface ToastOptions {
  type?: 'info' | 'success' | 'error';
  durationMs?: number;
  closeTab?: boolean;
}

const TOAST_ID = 'ala-toast';
let hideTimer: ReturnType<typeof setTimeout> | 0 = 0;
let ownUiRegistered = false;

export function showToast(msg: string, opts: ToastOptions = {}): void {
  const { type = 'info', durationMs = 6000, closeTab = false } = opts;
  Core.ready(() => {
    if (!ownUiRegistered) {
      ownUiRegistered = true;
      Core.registerOwnUi(`#${TOAST_ID}`);
    }
    let t = document.getElementById(TOAST_ID);
    if (!t) {
      t = document.createElement('div');
      t.id = TOAST_ID;
      t.setAttribute('role', 'status');
      t.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:4px;color:#fff;font-size:1.2rem;z-index:999999;box-shadow:0 4px 16px rgba(0,0,0,.45);max-width:min(90vw,480px);text-align:center';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = type === 'error' ? '#b23b3b' : type === 'success' ? '#2f8f5b' : '#2b6cb0';
    t.style.display = 'block';
    clearTimeout(hideTimer);
    if (durationMs > 0) {
      hideTimer = setTimeout(() => {
        if (t) t.style.display = 'none';
      }, durationMs);
    }
    if (closeTab) {
      setTimeout(() => safe(() => window.close()), 1800);
    }
  });
}

export const toastSuccess = (msg: string, opts: Omit<ToastOptions, 'type'> = {}): void =>
  showToast(msg, { ...opts, type: 'success' });

export const toastError = (msg: string, opts: Omit<ToastOptions, 'type'> = {}): void =>
  showToast(msg, { ...opts, type: 'error' });
