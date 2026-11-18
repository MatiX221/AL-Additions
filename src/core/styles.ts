import { Core } from './observer';
import type { CleanupFn } from '../types';

const styleRefCounts = new Map<string, number>();

export function addStyle(id: string, css: string): CleanupFn {
  let disposed = false;
  let cancelReady: CleanupFn | null = null;
  styleRefCounts.set(id, (styleRefCounts.get(id) || 0) + 1);

  const mount = () => {
    if (disposed) return;
    const parent = document.head || document.documentElement;
    if (!parent) return;
    if (!document.getElementById(id)) {
      const s = document.createElement('style');
      s.id = id;
      s.textContent = css;
      parent.appendChild(s);
    }
  };

  if (document.head) {
    mount();
  } else {
    cancelReady = Core.ready(mount);
  }

  return () => {
    if (disposed) return;
    disposed = true;
    cancelReady?.();
    cancelReady = null;
    const nextCount = (styleRefCounts.get(id) || 1) - 1;
    if (nextCount <= 0) {
      styleRefCounts.delete(id);
      document.getElementById(id)?.remove();
    } else {
      styleRefCounts.set(id, nextCount);
    }
  };
}
