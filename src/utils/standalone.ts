import { unsafeWindow } from 'vite-plugin-monkey/dist/client';
import { sleep } from './helpers';

const builtInRunning = new Set<string>();

/** Called by a built-in feature once it has actually started, so it is never mistaken for a standalone script. */
export const markBuiltIn = (id: string): void => {
  builtInRunning.add(id);
};

export const isBuiltInRunning = (id: string): boolean => builtInRunning.has(id);

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; result: Promise<boolean> }>();

export type StandaloneProbeFn = () => boolean | Promise<boolean>;

export const PROBE_ATTR = 'data-ala-probe';

const pageWin = (): any => (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

export function detectFastLoad(): boolean {
  const w = pageWin();
  return !!(w.__ANILIST_FAST_LOAD__ || w.__ANILIST_FAST_LOAD_V4__) && !isBuiltInRunning('fastLoad');
}

export async function probeTierLabels(timeoutMs = 600): Promise<boolean> {
  if (!document.body) return false;
  const probe = document.createElement('div');
  probe.className = 'score';
  probe.hidden = true;
  probe.setAttribute('score', '9');
  probe.setAttribute(PROBE_ATTR, '1');
  probe.textContent = '9';
  document.body.appendChild(probe);
  try {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await sleep(50);
      if (probe.hasAttribute('data-tier-modified')) return true;
    }
    return false;
  } finally {
    probe.remove();
  }
}

export function detectStandalone(id: string, probe?: StandaloneProbeFn, cacheMs = CACHE_MS): Promise<boolean> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < cacheMs) return hit.result;
  const runner: StandaloneProbeFn =
    probe || (id === 'fastLoad' ? detectFastLoad : id === 'tierLabels' ? probeTierLabels : () => false);
  const result = Promise.resolve()
    .then(() => runner())
    .then(Boolean)
    .catch(() => false);
  cache.set(id, { at: Date.now(), result });
  return result;
}
