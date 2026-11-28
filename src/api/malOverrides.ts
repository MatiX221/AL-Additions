import { SETTING_PREFIX, type ManualOverride, type ManualOverrideStore, type SyncMediaType } from '../types';
import { createCoreLogger, isAbortError, parseToggle, store } from '../utils/helpers';
import { AniList } from './anilist';

const malLog = createCoreLogger('mal');

export const OVERRIDES_SETTING_KEY = 'syncManualOverrides';
export const MANUAL_OVERRIDES_ENABLED_KEY = 'manualOverridesEnabled';

export function isManualOverridesEnabled(): boolean {
  return parseToggle(store.get(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY, false));
}

function normalizeOverrideEntry(
  key: string,
  val: unknown,
  defaultUpdatedAt: number
): { id: number; entry: ManualOverride } | { error: string } {
  const id = Number(key);
  if (!key || String(id) !== key || !Number.isSafeInteger(id) || id <= 0) {
    return {
      error: `Invalid AniList media ID key "${key}". Keys must be positive integers.`
    };
  }
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    return { error: `Invalid entry for media ID ${id}: expected an object.` };
  }
  const o = val as any;
  if (typeof o.malId !== 'number' || !Number.isSafeInteger(o.malId) || o.malId < 0) {
    return {
      error: `Invalid malId for media ID ${id}: must be a non-negative integer (0 for AniList-only).`
    };
  }

  let typeStr: string;
  if (o.type === undefined || o.type === null || o.type === '') {
    typeStr = 'ANIME';
  } else if (typeof o.type === 'string') {
    typeStr = o.type.trim().toUpperCase();
  } else {
    return { error: `Invalid type for media ID ${id}: must be "ANIME" or "MANGA".` };
  }
  if (typeStr !== 'ANIME' && typeStr !== 'MANGA') {
    return { error: `Invalid type for media ID ${id}: must be "ANIME" or "MANGA".` };
  }

  const entry: ManualOverride = {
    malId: o.malId === 0 ? 0 : o.malId,
    type: typeStr as SyncMediaType,
    title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : `Media #${id}`,
    updatedAt:
      typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) && o.updatedAt >= 0
        ? o.updatedAt
        : defaultUpdatedAt
  };
  if (typeof o.cover === 'string') {
    const cover = o.cover.trim();
    if (/^https?:\/\//i.test(cover)) {
      entry.cover = cover;
    }
  }

  return { id, entry };
}

export function getManualOverrides(): ManualOverrideStore {
  let raw = store.get<any>(SETTING_PREFIX + OVERRIDES_SETTING_KEY, {});
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (_) {
      raw = {};
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: ManualOverrideStore = {};
  for (const [key, val] of Object.entries(raw)) {
    const normalized = normalizeOverrideEntry(key, val, 0);
    if ('entry' in normalized) {
      result[String(normalized.id)] = normalized.entry;
    }
  }
  return result;
}

export function saveManualOverrides(overrides: ManualOverrideStore): void {
  store.set(SETTING_PREFIX + OVERRIDES_SETTING_KEY, overrides);
}

export function getOverride(mediaId: number): ManualOverride | undefined {
  if (!Number.isSafeInteger(mediaId) || mediaId <= 0 || !isManualOverridesEnabled()) return undefined;
  const all = getManualOverrides();
  return Object.prototype.hasOwnProperty.call(all, String(mediaId)) ? all[String(mediaId)] : undefined;
}

export function setOverride(
  mediaId: number,
  data: Omit<ManualOverride, 'updatedAt'> & { updatedAt?: number }
): void {
  if (!Number.isSafeInteger(mediaId) || mediaId <= 0) return;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const now = Date.now();
  const normalized = normalizeOverrideEntry(
    String(mediaId),
    {
      ...data,
      updatedAt:
        typeof data.updatedAt === 'number' && Number.isFinite(data.updatedAt) && data.updatedAt > 0
          ? data.updatedAt
          : now
    },
    now
  );
  if (!('entry' in normalized)) return;
  const all = { ...getManualOverrides() };
  all[String(normalized.id)] = normalized.entry;
  saveManualOverrides(all);
}

export function removeOverride(mediaId: number): void {
  if (!Number.isSafeInteger(mediaId) || mediaId <= 0) return;
  const all = { ...getManualOverrides() };
  delete all[String(mediaId)];
  saveManualOverrides(all);
}

export function isIgnored(mediaId: number): boolean {
  const o = getOverride(mediaId);
  return !!o && o.malId === 0;
}

export function getEffectiveMalId(mediaId: number, defaultMalId?: number | null): number | null {
  const o = getOverride(mediaId);
  if (o) {
    return o.malId > 0 ? o.malId : null;
  }
  return defaultMalId && defaultMalId > 0 ? defaultMalId : null;
}

export function validateOverrides(raw: unknown): {
  valid: boolean;
  overrides?: ManualOverrideStore;
  error?: string;
} {
  let data: any = raw;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return { valid: true, overrides: {} };
    try {
      data = JSON.parse(trimmed);
    } catch (e: any) {
      return { valid: false, error: `Invalid JSON syntax: ${e.message}` };
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      error: 'Overrides must be a JSON object mapping AniList media IDs to override records.'
    };
  }

  const now = Date.now();
  const result: ManualOverrideStore = {};
  for (const [key, val] of Object.entries(data)) {
    const normalized = normalizeOverrideEntry(key, val, now);
    if ('error' in normalized) {
      return { valid: false, error: normalized.error };
    }
    result[String(normalized.id)] = normalized.entry;
  }

  return { valid: true, overrides: result };
}

export function importOverrides(
  raw: unknown,
  mode: 'replace' | 'merge' = 'replace'
): { success: boolean; count?: number; error?: string } {
  const check = validateOverrides(raw);
  if (!check.valid || !check.overrides) {
    return { success: false, error: check.error || 'Validation failed' };
  }
  const next = mode === 'merge' ? { ...getManualOverrides(), ...check.overrides } : check.overrides;
  saveManualOverrides(next);
  return { success: true, count: Object.keys(check.overrides).length };
}

const STALE_MS = 24 * 3600 * 1000;
let refreshing = false;

export async function refreshStaleOverrides(opts?: { signal?: AbortSignal }): Promise<void> {
  const signal = opts?.signal;
  if (refreshing || signal?.aborted) return;
  const initial = getManualOverrides();
  const keys = Object.keys(initial);
  if (!keys.length) return;

  const staleIds = keys
    .map(Number)
    .filter((id) => id > 0 && (!initial[String(id)]?.updatedAt || Date.now() - initial[String(id)].updatedAt > STALE_MS))
    .sort((a, b) => (initial[String(a)]?.updatedAt || 0) - (initial[String(b)]?.updatedAt || 0));

  if (!staleIds.length) return;

  refreshing = true;
  try {
    for (let i = 0; i < staleIds.length; i += 50) {
      if (signal?.aborted) break;
      const batch = staleIds.slice(i, i + 50);
      const q = `query ($ids: [Int]) {
        Page(page: 1, perPage: 50) {
          media(id_in: $ids) {
            id
            type
            title { userPreferred english romaji }
            coverImage { medium }
          }
        }
      }`;

      try {
        const res = await AniList.query(q, { ids: batch }, { signal });
        if (signal?.aborted) break;
        const list = Array.isArray(res?.Page?.media) ? res.Page.media : [];
        const current = getManualOverrides();
        let changed = false;

        for (const m of list) {
          if (!m || m.id == null) continue;
          const idStr = String(m.id);
          if (Object.prototype.hasOwnProperty.call(current, idStr)) {
            const existing = current[idStr];
            const t = m.title?.userPreferred || m.title?.english || m.title?.romaji || existing.title;
            const cover = m.coverImage?.medium || existing.cover;
            const type = (m.type === 'MANGA' || m.type === 'ANIME' ? m.type : existing.type) as SyncMediaType;
            const nextEntry: ManualOverride = {
              ...existing,
              title: t,
              type,
              updatedAt: Date.now()
            };
            if (cover) nextEntry.cover = cover;
            else delete nextEntry.cover;
            current[idStr] = nextEntry;
            changed = true;
          }
        }

        if (changed && !signal?.aborted) {
          saveManualOverrides(current);
        }
      } catch (e) {
        if (signal?.aborted || isAbortError(e)) break;
        malLog.warn('Failed to refresh stale overrides batch:', e);
        break;
      }
    }
  } finally {
    refreshing = false;
  }
}
