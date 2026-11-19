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
});
