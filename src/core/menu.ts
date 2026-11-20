import { GM_registerMenuCommand } from 'vite-plugin-monkey/dist/client';
import { createCoreLogger } from '../utils/helpers';
import type { CleanupFn } from '../types';

const coreLog = createCoreLogger('core');

interface MenuEntry {
  handler: (() => void) | null;
  registered: boolean;
}

const entries = new Map<string, MenuEntry>();

function resolveRegisterMenuCommand(): typeof GM_registerMenuCommand | null {
  const g = globalThis as any;
  if (Object.prototype.hasOwnProperty.call(g, 'GM_registerMenuCommand')) {
    return typeof g.GM_registerMenuCommand === 'function' ? g.GM_registerMenuCommand : null;
  }
  return typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : null;
}

export function registerMenuCommand(label: string, onClick: () => void): CleanupFn {
  let entry = entries.get(label);
  if (!entry) {
    entry = { handler: null, registered: false };
    entries.set(label, entry);
  }
  entry.handler = onClick;

  if (!entry.registered) {
    const regFn = resolveRegisterMenuCommand();
    if (regFn) {
      entry.registered = true;
      regFn(label, () => {
        try {
          entry?.handler?.();
        } catch (e) {
          coreLog.error(`Menu command "${label}" failed:`, e);
        }
      });
    }
  }

  return () => {
    if (entry && entry.handler === onClick) {
      entry.handler = null;
    }
  };
}
