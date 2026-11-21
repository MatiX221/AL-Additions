import { describe, it, expect } from 'vitest';
import '../src/modules/tierLabels';
import {
  DEFAULT_TIERS,
  getTier,
  validateTiers,
  isValidColor,
  normalizeHexColor,
  type TierConfig
} from '../src/modules/tierLabels/tiers';
import { getValidTiers } from '../src/modules/tierLabels';
import { Settings } from '../src/settings/settings';
import { runMigrations, bootModuleForTest, disposeFeature } from '../src/core/registry';
import { store } from '../src/utils/helpers';

function expectTiersMatch(actual: TierConfig[], expected: TierConfig[]) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((tier, i) => {
    expect(tier.label).toBe(expected[i].label);
    expect(tier.min).toBe(expected[i].min);
    expect(tier.max).toBe(expected[i].max);
    expect(tier.color.toLowerCase()).toBe(expected[i].color.toLowerCase());
    expect(tier.textColor.toLowerCase()).toBe(expected[i].textColor.toLowerCase());
  });
}

describe('Tier Labels: Range Matching (getTier)', () => {
  it('correctly maps scores to default tier brackets', () => {
    expect(getTier(100, DEFAULT_TIERS)?.label).toBe('S+');
    expect(getTier(95, DEFAULT_TIERS)?.label).toBe('S+');
    expect(getTier(94.9, DEFAULT_TIERS)?.label).toBe('S');
    expect(getTier(85, DEFAULT_TIERS)?.label).toBe('S');
    expect(getTier(84.9, DEFAULT_TIERS)?.label).toBe('A');
    expect(getTier(75, DEFAULT_TIERS)?.label).toBe('A');
    expect(getTier(74.9, DEFAULT_TIERS)?.label).toBe('B');
    expect(getTier(65, DEFAULT_TIERS)?.label).toBe('B');
    expect(getTier(64.9, DEFAULT_TIERS)?.label).toBe('C');
    expect(getTier(55, DEFAULT_TIERS)?.label).toBe('C');
    expect(getTier(54.9, DEFAULT_TIERS)?.label).toBe('D');
    expect(getTier(41, DEFAULT_TIERS)?.label).toBe('D');
    expect(getTier(40.9, DEFAULT_TIERS)?.label).toBe('F');
    expect(getTier(1, DEFAULT_TIERS)?.label).toBe('F');
  });

  it('returns null for zero, negative, or invalid score values', () => {
    expect(getTier(0, DEFAULT_TIERS)).toBeNull();
    expect(getTier(-5, DEFAULT_TIERS)).toBeNull();
    expect(getTier(NaN, DEFAULT_TIERS)).toBeNull();
    expect(getTier(Infinity, DEFAULT_TIERS)).toBeNull();
  });

  it('tolerates floating-point precision gaps between adjacent tiers', () => {
    const tier = getTier(94.95, DEFAULT_TIERS);
    expect(tier).not.toBeNull();
    expect(['S', 'S+']).toContain(tier?.label);
  });
});

describe('Tier Labels: Color Utilities', () => {
  it('validates hex codes, css functions, and named colors', () => {
    expect(isValidColor('#fff')).toBe(true);
    expect(isValidColor('#FFD700')).toBe(true);
    expect(isValidColor('#3db4f280')).toBe(true);
    expect(isValidColor('rgb(255, 0, 0)')).toBe(true);
    expect(isValidColor('hsl(120, 100%, 50%)')).toBe(true);
    expect(isValidColor('gold')).toBe(true);
    expect(isValidColor('transparent')).toBe(true);

    expect(isValidColor('')).toBe(false);
    expect(isValidColor('not-a-color')).toBe(false);
    expect(isValidColor('#12345')).toBe(false);
  });

  it('normalizes 3-character hex shorthand to standard 6-character hex', () => {
    expect(normalizeHexColor('#fff')).toBe('#ffffff');
    expect(normalizeHexColor('#000')).toBe('#000000');
    expect(normalizeHexColor('#f0a')).toBe('#ff00aa');
    expect(normalizeHexColor('#FFD700')).toBe('#ffd700');
  });
});

describe('Tier Labels: Schema Validation (validateTiers)', () => {
  it('validates default tiers successfully', () => {
    const result = validateTiers(DEFAULT_TIERS);
    expect(result.valid).toBe(true);
    expect(result.tiers?.length).toBe(DEFAULT_TIERS.length);
  });

  it('rejects non-array or empty configurations', () => {
    expect(validateTiers(null).valid).toBe(false);
    expect(validateTiers({}).valid).toBe(false);
    expect(validateTiers([]).valid).toBe(false);
  });

  it('rejects entries with missing or excessively long labels', () => {
    const missingLabel: TierConfig[] = [
      { min: 0, max: 100, label: '', color: '#fff', textColor: '#000' }
    ];
    expect(validateTiers(missingLabel).valid).toBe(false);

    const longLabel: TierConfig[] = [
      { min: 0, max: 100, label: 'Super Ultra Ultimate Tier Name', color: '#fff', textColor: '#000' }
    ];
    expect(validateTiers(longLabel).valid).toBe(false);
  });

  it('rejects inverted or out-of-range score intervals', () => {
    const inverted: TierConfig[] = [
      { min: 90, max: 70, label: 'Bad', color: '#fff', textColor: '#000' }
    ];
    expect(validateTiers(inverted).valid).toBe(false);

    const outOfBounds: TierConfig[] = [
      { min: -5, max: 105, label: 'Bad', color: '#fff', textColor: '#000' }
    ];
    expect(validateTiers(outOfBounds).valid).toBe(false);
  });

  it('rejects configurations with invalid badge or text colors', () => {
    const badColor: TierConfig[] = [
      { min: 0, max: 100, label: 'Test', color: 'invalid-hex', textColor: '#fff' }
    ];
    expect(validateTiers(badColor).valid).toBe(false);

    const badTextColor: TierConfig[] = [
      { min: 0, max: 100, label: 'Test', color: '#000', textColor: 'invalid-hex' }
    ];
    expect(validateTiers(badTextColor).valid).toBe(false);
  });

  it('normalizes numbers to 2 decimal places and hex values to lowercase', () => {
    const raw = [
      { min: '85.456', max: '100', label: 'Top', color: '#ABC', textColor: '#FFF' }
    ];
    const result = validateTiers(raw);
    expect(result.valid).toBe(true);
    expect(result.tiers?.[0]).toEqual({
      min: 85.46,
      max: 100,
      label: 'Top',
      color: '#aabbcc',
      textColor: '#ffffff'
    });
  });
});

describe('Tier Labels: Config Resolution (getValidTiers)', () => {
  it('returns DEFAULT_TIERS when no custom configuration is passed', () => {
    const tiers = getValidTiers();
    expectTiersMatch(tiers, DEFAULT_TIERS);
  });

  it('returns customized tiers when valid configuration is passed', () => {
    const customTiers: TierConfig[] = [
      { min: 90, max: 100, label: 'GOAT', color: '#ffd700', textColor: '#000000' },
      { min: 0, max: 89.9, label: 'Mid', color: '#888888', textColor: '#ffffff' }
    ];

    const tiers = getValidTiers(customTiers);

    expect(tiers.length).toBe(2);
    expect(tiers[0].label).toBe('GOAT');
    expect(tiers[1].label).toBe('Mid');
  });

  it('falls back to DEFAULT_TIERS if stored settings value is corrupted or invalid', () => {
    const tiers = getValidTiers([{ min: 100, max: 0, label: 'Corrupted' }]);

    expectTiersMatch(tiers, DEFAULT_TIERS);
  });
});
describe('Tier Labels: Migration & Session Score Format', () => {
  it('migrates legacy localStorage settings and standalone_seen key into ala_mod_tierLabels_* via runMigrations()', () => {
    localStorage.setItem(
      'anilistTierLabelsSettings',
      JSON.stringify({
        tiers: [{ min: 0, max: 100, label: 'ALL', color: '#112233', textColor: '#ffffff' }],
        enableRatingTextColor: false
      })
    );
    store.set('ala_standalone_seen_tierLabels', true);

    runMigrations();

    expect(Settings.get('tierLabels')[0].label).toBe('ALL');
    expect(Settings.get('tierLabelsColorScore')).toBe(false);
    expect(store.get('ala_mod_tierLabels_standalone_seen', null)).toBe(true);
    expect(store.get('ala_standalone_seen_tierLabels', null)).toBeNull();
    localStorage.removeItem('anilistTierLabelsSettings');
  });

  it('reads viewer scoreFormat from ctx.session.scoreFormat during scan passes', async () => {
    Settings.set('tierLabels', DEFAULT_TIERS);
    Settings.set('tierLabelsEnabled', true);
    store.set('ala_mod_tierLabels_standalone_seen', false);
    store.set('al_score_format', 'POINT_5');

    document.body.innerHTML = '<div class="score" score="5">5</div>';
    await bootModuleForTest('tierLabels');

    const scoreEl = document.querySelector<HTMLElement>('.score')!;
    expect(scoreEl.dataset.tierModified).toBe('true');
    expect(scoreEl.textContent).toContain('S+');
    disposeFeature('tierLabels');
  });
});
