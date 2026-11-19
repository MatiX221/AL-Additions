import { store } from '../utils/helpers';
import type { AccountProvider, CleanupFn } from '../types';

const providers = new Map<string, AccountProvider>();

export function registerAccountProvider(provider: AccountProvider): CleanupFn {
  providers.set(provider.id, provider);
  return () => {
    if (providers.get(provider.id) === provider) {
      providers.delete(provider.id);
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
      console.error('[AL-Additions]', `account auth callback (${p.id})`, e);
    }
  }
}
