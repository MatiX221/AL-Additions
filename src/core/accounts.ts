import { createCoreLogger, store } from '../utils/helpers';
import type { AccountProvider, CleanupFn } from '../types';

const coreLog = createCoreLogger('core');
const providers = new Map<string, AccountProvider>();

interface AccountWatcherEntry {
  providerId: string;
  cb: (connected: boolean) => void;
  active: boolean;
  lastConnected: boolean;
  keyUnsubs: CleanupFn[];
}

const watchersByProvider = new Map<string, Set<AccountWatcherEntry>>();

function isProviderConnected(providerId: string): boolean {
  try {
    return !!providers.get(providerId)?.isConnected();
  } catch {
    return false;
  }
}

function clearEntryKeyUnsubs(entry: AccountWatcherEntry): void {
  for (const unsub of entry.keyUnsubs) {
    try {
      unsub();
    } catch {}
  }
  entry.keyUnsubs.length = 0;
}

function notifyWatcherTransition(entry: AccountWatcherEntry): void {
  if (!entry.active) return;
  const next = isProviderConnected(entry.providerId);
  if (next === entry.lastConnected) return;
  entry.lastConnected = next;
  try {
    entry.cb(next);
  } catch (e) {
    coreLog.error(`Account watcher (${entry.providerId}) failed:`, e);
  }
}

function bindEntryKeys(entry: AccountWatcherEntry): void {
  clearEntryKeyUnsubs(entry);
  if (!entry.active) return;
  const keys = getAccountSecretKeys(entry.providerId);
  for (const key of keys) {
    entry.keyUnsubs.push(
      store.watch(key, () => {
        notifyWatcherTransition(entry);
      })
    );
  }
}

function reconcileWatchersForProvider(providerId: string): void {
  const set = watchersByProvider.get(providerId);
  if (!set) return;
  for (const entry of [...set]) {
    if (!entry.active) continue;
    bindEntryKeys(entry);
    notifyWatcherTransition(entry);
  }
}

export function registerAccountProvider(provider: AccountProvider): CleanupFn {
  providers.set(provider.id, provider);
  reconcileWatchersForProvider(provider.id);
  return () => {
    if (providers.get(provider.id) === provider) {
      providers.delete(provider.id);
      reconcileWatchersForProvider(provider.id);
    }
  };
}

export function watchAccountProvider(providerId: string, cb: (connected: boolean) => void): CleanupFn {
  const entry: AccountWatcherEntry = {
    providerId,
    cb,
    active: true,
    lastConnected: isProviderConnected(providerId),
    keyUnsubs: []
  };
  let set = watchersByProvider.get(providerId);
  if (!set) {
    set = new Set();
    watchersByProvider.set(providerId, set);
  }
  set.add(entry);
  bindEntryKeys(entry);

  return () => {
    if (!entry.active) return;
    entry.active = false;
    clearEntryKeyUnsubs(entry);
    set?.delete(entry);
    if (set && set.size === 0 && watchersByProvider.get(providerId) === set) {
      watchersByProvider.delete(providerId);
    }
  };
}

export function getAccountProvider(id: string): AccountProvider | undefined {
  return providers.get(id);
}

export function listAccountProviders(): AccountProvider[] {
  return [...providers.values()];
}

export function getAccountSecretKeys(providerId?: string): string[] {
  if (providerId !== undefined) {
    const p = providers.get(providerId);
    return p ? [...new Set(p.secretKeys)] : [];
  }
  const keys = new Set<string>();
  for (const p of providers.values()) {
    for (const k of p.secretKeys) keys.add(k);
  }
  return [...keys];
}

export function clearAccountSecrets(providerId?: string): void {
  for (const key of getAccountSecretKeys(providerId)) {
    store.del(key);
  }
}

export async function runAccountAuthCallbacks(): Promise<void> {
  for (const p of [...providers.values()]) {
    if (!p.onAuthCallback) continue;
    try {
      await p.onAuthCallback!();
    } catch (e) {
      coreLog.error(`Account auth callback (${p.id}) failed:`, e);
    }
  }
}
