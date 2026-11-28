import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MANUAL_OVERRIDES_ENABLED_KEY,
  OVERRIDES_SETTING_KEY,
  getEffectiveMalId,
  getManualOverrides,
  getOverride,
  isIgnored,
  refreshStaleOverrides,
  removeOverride,
  setOverride,
  validateOverrides
} from '../src/api/malOverrides';
import { AniList } from '../src/api/anilist';
import { SETTING_PREFIX } from '../src/types';
import { store } from '../src/utils/helpers';

describe('MAL Overrides: Sanitization & Validation (B1-18)', () => {
  beforeEach(() => {
    store.del(SETTING_PREFIX + OVERRIDES_SETTING_KEY);
    store.del(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sanitizes and skips corrupted entries in getManualOverrides() without crashing consumers', () => {
    store.set(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY, true);
    const corruptedJson = JSON.stringify({
      constructor: { malId: 999, type: 'ANIME', title: 'Proto' },
      '0': { malId: 10, type: 'ANIME' },
      '-5': { malId: 10, type: 'ANIME' },
      '1.5': { malId: 10, type: 'ANIME' },
      '10': null,
      '11': ['bad'],
      '12': { malId: '123', type: 'ANIME', title: 'String malId' },
      '13': { malId: -1, type: 'ANIME', title: 'Negative malId' },
      '14': { malId: 1.5, type: 'ANIME', title: 'Float malId' },
      '15': { malId: 100, type: 'NOVEL', title: 'Bad type' },
      '16': { malId: 100, type: 123, title: 'Numeric type' },
      '17': { malId: 200 },
      '18': { malId: 0, type: 'manga', title: '  My Manga  ', updatedAt: 'bad', cover: '  https://img/c.jpg  ' },
      '19': { malId: 300, type: 'ANIME', title: 'Valid Entry', updatedAt: 5000 }
    });
    store.set(SETTING_PREFIX + OVERRIDES_SETTING_KEY, corruptedJson);

    const sanitized = getManualOverrides();
    expect(Object.keys(sanitized).sort()).toEqual(['17', '18', '19']);

    expect(sanitized['17']).toEqual({
      malId: 200,
      type: 'ANIME',
      title: 'Media #17',
      updatedAt: 0
    });
    expect(sanitized['18']).toEqual({
      malId: 0,
      type: 'MANGA',
      title: 'My Manga',
      cover: 'https://img/c.jpg',
      updatedAt: 0
    });
    expect(sanitized['19']).toEqual({
      malId: 300,
      type: 'ANIME',
      title: 'Valid Entry',
      updatedAt: 5000
    });

    const sorted = Object.entries(sanitized).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    expect(sorted[0][0]).toBe('19');
    for (const [, entry] of sorted) {
      expect(Number.isFinite(entry.updatedAt)).toBe(true);
      expect(() => entry.type.toLowerCase()).not.toThrow();
    }

    expect(getEffectiveMalId(17, null)).toBe(200);
    expect(getEffectiveMalId(18, 999)).toBeNull();
    expect(isIgnored(18)).toBe(true);
    expect(getEffectiveMalId(12, 888)).toBe(888);
    expect(getOverride(0)).toBeUndefined();
    expect(getOverride(-5)).toBeUndefined();
  });

  it('guards setOverride() and removeOverride() against invalid IDs and malformed inputs', () => {
    setOverride(0, { malId: 10, type: 'ANIME', title: 'Zero ID' });
    setOverride(-1, { malId: 10, type: 'ANIME', title: 'Neg ID' });
    setOverride(1.5, { malId: 10, type: 'ANIME', title: 'Float ID' });
    setOverride(NaN, { malId: 10, type: 'ANIME', title: 'NaN ID' });
    setOverride(100, { malId: -1, type: 'ANIME', title: 'Neg malId' });
    setOverride(100, { malId: '123' as any, type: 'ANIME', title: 'String malId' });
    setOverride(100, { malId: 50, type: 'NOVEL' as any, title: 'Bad type' });
    expect(getManualOverrides()).toEqual({});

    setOverride(100, { malId: 0, type: 'manga' as any, title: '  Valid Manga  ' });
    const stored = getManualOverrides()['100'];
    expect(stored.malId).toBe(0);
    expect(stored.type).toBe('MANGA');
    expect(stored.title).toBe('Valid Manga');
    expect(stored.updatedAt).toBeGreaterThan(0);

    removeOverride(0);
    removeOverride(-1);
    expect(Object.keys(getManualOverrides())).toEqual(['100']);

    removeOverride(100);
    expect(getManualOverrides()).toEqual({});
  });

  it('validates imported overrides consistently and rejects prototype keys and non-finite fields', () => {
    expect(validateOverrides('{"constructor":{"malId":1,"type":"ANIME"}}').valid).toBe(false);
    expect(validateOverrides('{"__proto__":{"malId":1,"type":"ANIME"}}').valid).toBe(false);
    expect(validateOverrides({ '10': null }).valid).toBe(false);
    expect(validateOverrides({ '10': { malId: '5', type: 'ANIME' } }).valid).toBe(false);
    expect(validateOverrides({ '10': { malId: 5, type: 'NOVEL' } }).valid).toBe(false);

    const ok = validateOverrides({
      '10': { malId: 55, type: 'manga', updatedAt: Infinity },
      '20': { malId: 0 }
    });
    expect(ok.valid).toBe(true);
    expect(ok.overrides?.['10'].type).toBe('MANGA');
    expect(Number.isFinite(ok.overrides?.['10'].updatedAt)).toBe(true);
    expect(ok.overrides?.['20']).toMatchObject({
      malId: 0,
      type: 'ANIME',
      title: 'Media #20'
    });
  });

  it('persists updatedAt in refreshStaleOverrides() even when title, cover, and type are unchanged', async () => {
    const oldTs = Date.now() - 48 * 3600 * 1000;
    store.set(SETTING_PREFIX + OVERRIDES_SETTING_KEY, {
      '16498': {
        malId: 16498,
        type: 'ANIME',
        title: 'Attack on Titan',
        cover: 'https://img/aot.jpg',
        updatedAt: oldTs
      },
      '21': {
        malId: 21,
        type: 'ANIME',
        title: 'One Piece',
        cover: 'https://img/op.jpg'
      }
    });

    const querySpy = vi.spyOn(AniList, 'query').mockResolvedValue({
      Page: {
        media: [
          {
            id: 16498,
            type: 'ANIME',
            title: { userPreferred: 'Attack on Titan' },
            coverImage: { medium: 'https://img/aot.jpg' }
          },
          {
            id: 21,
            type: 'ANIME',
            title: { userPreferred: 'One Piece' },
            coverImage: { medium: 'https://img/op.jpg' }
          }
        ]
      }
    });

    await refreshStaleOverrides();
    expect(querySpy).toHaveBeenCalledTimes(1);

    const after = getManualOverrides();
    expect(after['16498'].updatedAt).toBeGreaterThan(oldTs);
    expect(after['16498'].title).toBe('Attack on Titan');
    expect(after['21'].updatedAt).toBeGreaterThan(0);

    await refreshStaleOverrides();
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('preserves existing.type when refreshStaleOverrides() receives missing or unknown m.type', async () => {
    const oldTs = Date.now() - 48 * 3600 * 1000;
    store.set(SETTING_PREFIX + OVERRIDES_SETTING_KEY, {
      '300': {
        malId: 300,
        type: 'MANGA',
        title: 'Old Manga 1',
        updatedAt: oldTs
      },
      '301': {
        malId: 301,
        type: 'MANGA',
        title: 'Old Manga 2',
        updatedAt: oldTs
      }
    });

    vi.spyOn(AniList, 'query').mockResolvedValue({
      Page: {
        media: [
          {
            id: 300,
            title: { userPreferred: 'Updated Manga 1' }
          },
          {
            id: 301,
            type: 'NOVEL',
            title: { userPreferred: 'Updated Manga 2' }
          }
        ]
      }
    });

    await refreshStaleOverrides();

    const after = getManualOverrides();
    expect(after['300'].type).toBe('MANGA');
    expect(after['300'].title).toBe('Updated Manga 1');
    expect(after['300'].updatedAt).toBeGreaterThan(oldTs);
    expect(after['301'].type).toBe('MANGA');
    expect(after['301'].title).toBe('Updated Manga 2');
    expect(after['301'].updatedAt).toBeGreaterThan(oldTs);
  });

  it('rejects non-http(s) cover URLs in normalizeOverrideEntry across store read, setOverride, and validateOverrides (BUG-51)', () => {
    store.set(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY, true);
    store.set(SETTING_PREFIX + OVERRIDES_SETTING_KEY, {
      '101': { malId: 201, type: 'ANIME', title: 'Bad JS', cover: 'javascript:alert(1)' },
      '102': { malId: 202, type: 'ANIME', title: 'Bad Data', cover: 'data:text/html,<script>alert(1)</script>' },
      '103': { malId: 203, type: 'ANIME', title: 'Bad Relative', cover: '/relative/path.jpg' },
      '104': { malId: 204, type: 'ANIME', title: 'Good HTTPS', cover: '  HTTPS://cdn.example.com/a.jpg  ' },
      '105': { malId: 205, type: 'ANIME', title: 'Good HTTP', cover: 'http://cdn.example.com/b.jpg' }
    });

    const loaded = getManualOverrides();
    expect(loaded['101'].cover).toBeUndefined();
    expect(loaded['102'].cover).toBeUndefined();
    expect(loaded['103'].cover).toBeUndefined();
    expect(loaded['104'].cover).toBe('HTTPS://cdn.example.com/a.jpg');
    expect(loaded['105'].cover).toBe('http://cdn.example.com/b.jpg');

    setOverride(106, { malId: 206, type: 'MANGA', title: 'Set Bad', cover: 'vbscript:msgbox(1)' });
    expect(getManualOverrides()['106'].cover).toBeUndefined();

    const validated = validateOverrides({
      '107': { malId: 207, type: 'ANIME', title: 'Imported', cover: 'javascript:void(0)' },
      '108': { malId: 208, type: 'ANIME', title: 'Imported OK', cover: 'https://img.example.com/ok.png' }
    });
    expect(validated.valid).toBe(true);
    expect(validated.overrides?.['107'].cover).toBeUndefined();
    expect(validated.overrides?.['108'].cover).toBe('https://img.example.com/ok.png');
  });

  it('aborts refreshStaleOverrides({ signal }) mid-batch without writing aborted batches or logging warnings (IMP-11)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oldTs = Date.now() - 48 * 3600 * 1000;
    const initial: Record<string, any> = {};
    for (let id = 1; id <= 60; id++) {
      initial[String(id)] = {
        malId: id + 1000,
        type: 'ANIME',
        title: `Old Title ${id}`,
        updatedAt: oldTs + id
      };
    }
    store.set(SETTING_PREFIX + OVERRIDES_SETTING_KEY, initial);

    // 1. Pre-aborted signal exits immediately without querying
    const preAc = new AbortController();
    preAc.abort();
    const querySpy = vi.spyOn(AniList, 'query');
    await refreshStaleOverrides({ signal: preAc.signal });
    expect(querySpy).not.toHaveBeenCalled();

    // 2. Abort during batch 1 (with 60 stale entries -> 2 batches) skips storage writes, batch 2, and warnings
    const acMid = new AbortController();
    querySpy.mockImplementationOnce(async (_q, _vars, opts) => {
      expect(typeof opts === 'object' ? opts.signal : undefined).toBe(acMid.signal);
      acMid.abort();
      throw new DOMException('Request aborted', 'AbortError');
    });

    await refreshStaleOverrides({ signal: acMid.signal });
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(getManualOverrides()['1'].title).toBe('Old Title 1');
    expect(getManualOverrides()['1'].updatedAt).toBe(oldTs + 1);

    // 3. Abort after batch 1 completes saves batch 1 and skips batch 2
    const acBetween = new AbortController();
    querySpy.mockReset();
    querySpy.mockImplementationOnce(async (_q, vars, opts) => {
      expect(typeof opts === 'object' ? opts.signal : undefined).toBe(acBetween.signal);
      expect((vars as { ids: number[] }).ids).toHaveLength(50);
      acBetween.abort();
      return {
        Page: {
          media: [
            {
              id: 1,
              type: 'ANIME',
              title: { userPreferred: 'Should Not Persist On Abort' }
            }
          ]
        }
      };
    });
    await refreshStaleOverrides({ signal: acBetween.signal });
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(getManualOverrides()['1'].title).toBe('Old Title 1');

    // 4. Batch 1 succeeds, then abort fires before batch 2 starts -> batch 1 persists, batch 2 skipped
    const acAfterBatch1 = new AbortController();
    querySpy.mockReset();
    const setSpy = vi.spyOn(store, 'set').mockImplementationOnce((k, v) => {
      const prev = getManualOverrides();
      void prev;
      acAfterBatch1.abort();
      globalThis.GM_setValue(k, v);
    });
    querySpy.mockImplementationOnce(async (_q, vars) => {
      expect((vars as { ids: number[] }).ids).toHaveLength(50);
      return {
        Page: {
          media: [
            {
              id: 1,
              type: 'ANIME',
              title: { userPreferred: 'Updated Title 1' }
            }
          ]
        }
      };
    });
    await refreshStaleOverrides({ signal: acAfterBatch1.signal });
    setSpy.mockRestore();
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(getManualOverrides()['1'].title).toBe('Updated Title 1');
    expect(getManualOverrides()['51'].title).toBe('Old Title 51');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
