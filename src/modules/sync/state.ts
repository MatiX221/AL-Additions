import { randomString, sleep } from '../../utils/helpers';
import type { AniListClient, Logger, StorageScope } from '../../types';
import { TYPES, SyncMediaType, SyncProgress, FlaggedError, PendingDelete } from './types';

const fallbackMemory = new Map<string, any>();
const fallbackStorage: StorageScope = {
  get: <T = any>(key: string, def?: T): T =>
    (fallbackMemory.has(key) ? fallbackMemory.get(key) : def) as T,
  set: (key: string, val: any): void => {
    fallbackMemory.set(key, val);
  },
  del: (key: string): void => {
    fallbackMemory.delete(key);
  },
  clear: (): void => {
    fallbackMemory.clear();
  },
  watch: () => () => {}
};

let activeStorage: StorageScope | null = null;
export function setSyncStorage(storage: StorageScope | null): void {
  activeStorage = storage;
}
const scoped = (): StorageScope => activeStorage ?? fallbackStorage;

export const syncStore = {
  get: <T>(k: string, d?: T): T => scoped().get<T>(k, d),
  set: <T>(k: string, v: T): void => scoped().set(k, v),
  del: (k: string): void => scoped().del(k),
  jsonGet: <T>(k: string, d: T): T => {
    const raw = scoped().get<any>(k, null);
    if (raw == null) return d;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return d;
      }
    }
    return raw as T;
  },
  jsonSet: <T>(k: string, v: T): void => scoped().set(k, v),
  clearKnown: (): void => {
    scoped().clear();
  }
};

export let syncLog: Logger<true> | null = null;
export function setSyncLog(log: Logger<true> | null): void {
  syncLog = log;
}

export let syncApi: AniListClient | null = null;
export function setSyncApi(api: AniListClient | null): void {
  syncApi = api;
}

type SettingGetter = <T = any>(key: string) => T;
const defaultSyncGet: SettingGetter = <T = any>(key: string): T => {
  if (key === 'syncScoreRounding') return 'round' as T;
  if (key === 'syncMode') return 'update' as T;
  if (key === 'syncIntervalAnime' || key === 'syncIntervalManga') return 6 as T;
  if (key === 'syncEnabled') return true as T;
  return false as T;
};
export let syncGet: SettingGetter = defaultSyncGet;
export function setSyncGet(getter: SettingGetter | null): void {
  syncGet = getter ?? defaultSyncGet;
}

export const ID_MISS_TTL_MS = 7 * 86400e3;
const SETTLED_TTL_MS = 45 * 86400e3;
const LOCK_STALE_MS = 45e3;
const LOCK_HEARTBEAT_MS = 10e3;
const TAB_ID = randomString(10);
const LOCK_KEY = 'lock_heartbeat';

export const progress: SyncProgress = { phase: 'idle', done: 0, total: 0, changed: 0 };
export const syncStatus = { syncing: false, cancelled: false, autoSyncRetryAfter: 0 };

const progressListeners = new Set<(force: boolean) => void>();
const stateListeners = new Set<() => void>();
export const onProgressChange = (cb: (force: boolean) => void): (() => void) => {
  progressListeners.add(cb);
  return () => {
    progressListeners.delete(cb);
  };
};
export const onStateChange = (cb: () => void): (() => void) => {
  stateListeners.add(cb);
  return () => {
    stateListeners.delete(cb);
  };
};
export const notifyProgress = (force = false): void => {
  for (const cb of [...progressListeners]) cb(force);
};
export const notifyState = (): void => {
  for (const cb of [...stateListeners]) cb();
};

export const markDone = (n = 1): void => {
  progress.done += n;
  notifyProgress();
};

export const checkCancel = (): void => {
  if (syncStatus.cancelled) {
    const e: FlaggedError = new Error('Sync stopped.');
    e.cancelled = true;
    throw e;
  }
};

const pruneIds = (d: Record<string, any>): void => {
  for (const k of Object.keys(d)) {
    const r = d[k];
    if (!r || typeof r !== 'object' || (!(r.m > 0) && !(Date.now() - r.t < ID_MISS_TTL_MS))) delete d[k];
  }
};
const pruneSettled = (d: Record<string, any>): void => {
  for (const k of Object.keys(d)) {
    const r = d[k];
    if (!Array.isArray(r) || !(Date.now() - r[2] < SETTLED_TTL_MS)) delete d[k];
  }
};

type PersistentFactory = <T extends Record<string, any>>(
  key: string,
  prune?: (data: T) => void
) => { data: T; save: () => void };

const makeEmptyStore = () => ({ data: {} as Record<string, any>, save: () => {} });

export const stores: Record<SyncMediaType, { ids: any; settled: any }> = {
  ANIME: { ids: makeEmptyStore(), settled: makeEmptyStore() },
  MANGA: { ids: makeEmptyStore(), settled: makeEmptyStore() }
};

export function initSyncStores(createPersistent: PersistentFactory): void {
  for (const t of TYPES) {
    stores[t].ids = createPersistent<Record<string, any>>(`idmap_${t}`, pruneIds);
    stores[t].settled = createPersistent<Record<string, any>>(`settled_${t}`, pruneSettled);
  }
}

export const clearCache = (c: { data: Record<string, any>; save: () => void }): void => {
  for (const k of Object.keys(c.data)) delete c.data[k];
  c.save();
};

export const PENDING_DELETES_KEY = 'pending_deletes';

export function getPendingDeletes(): PendingDelete[] {
  return syncStore.jsonGet<PendingDelete[]>(PENDING_DELETES_KEY, []);
}

export function addPendingDelete(del: PendingDelete): void {
  const list = getPendingDeletes().filter((p) => !(p.mediaId === del.mediaId && p.type === del.type));
  list.push(del);
  syncStore.jsonSet(PENDING_DELETES_KEY, list);
}

export function removePendingDelete(mediaId: number, type: SyncMediaType): void {
  const list = getPendingDeletes().filter((p) => !(p.mediaId === mediaId && p.type === type));
  syncStore.jsonSet(PENDING_DELETES_KEY, list);
}

export function clearPendingDeletes(type?: SyncMediaType): void {
  if (type) {
    const list = getPendingDeletes().filter((p) => p.type !== type);
    syncStore.jsonSet(PENDING_DELETES_KEY, list);
  } else {
    syncStore.del(PENDING_DELETES_KEY);
  }
}

export function resetAccountState(): void {
  for (const t of TYPES) {
    for (const k of ['last_sync', 'last_run', 'last_compare']) syncStore.del(`${k}_${t}`);
    clearCache(stores[t].settled);
  }
  syncStore.del('sync_retry_at');
  syncStore.del(PENDING_DELETES_KEY);
}

let heartbeat: ReturnType<typeof setInterval> | null = null;

export async function acquireLock(): Promise<boolean> {
  const lock = syncStore.jsonGet<any>(LOCK_KEY, null);
  if (lock && lock.tab !== TAB_ID && Number.isFinite(lock.at) && Date.now() - lock.at < LOCK_STALE_MS) return false;
  const beat = () => syncStore.jsonSet(LOCK_KEY, { at: Date.now(), tab: TAB_ID });
  beat();
  await sleep(250);
  if (syncStore.jsonGet<any>(LOCK_KEY, null)?.tab !== TAB_ID) return false;
  heartbeat = setInterval(beat, LOCK_HEARTBEAT_MS);
  return true;
}

export function releaseLock(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (syncStore.jsonGet<any>(LOCK_KEY, null)?.tab === TAB_ID) syncStore.del(LOCK_KEY);
}