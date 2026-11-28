import { Core } from './observer';
import type { CleanupFn, CssSource } from '../types';

const styleRefCounts = new Map<string, number>();
const styleGenerations = new Map<string, number>();

export function prefixAlaId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('ala-') ? trimmed : `ala-${trimmed}`;
}

export function addStyle(id: string, css: CssSource): CleanupFn {
  const styleId = prefixAlaId(id) || 'ala-style';
  let disposed = false;
  let cancelReady: CleanupFn | null = null;
  styleRefCounts.set(styleId, (styleRefCounts.get(styleId) || 0) + 1);
  const myGen = (styleGenerations.get(styleId) || 0) + 1;
  styleGenerations.set(styleId, myGen);

  const mount = () => {
    if (disposed || styleGenerations.get(styleId) !== myGen) return;
    const parent = document.head || document.documentElement;
    if (!parent) return;
    const text = typeof css === 'function' ? css() : css;
    const existing = document.getElementById(styleId);
    if (existing) {
      if (existing.textContent !== text) existing.textContent = text;
      return;
    }
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = text;
    parent.appendChild(s);
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
    const nextCount = (styleRefCounts.get(styleId) || 1) - 1;
    if (nextCount <= 0) {
      styleRefCounts.delete(styleId);
      styleGenerations.delete(styleId);
      document.getElementById(styleId)?.remove();
    } else {
      styleRefCounts.set(styleId, nextCount);
    }
  };
}
