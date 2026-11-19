import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../src/modules/fastLoad';
import '../src/modules/tagFilter';
import '../src/modules/shortUrls';
import '../src/modules/banner';
import '../src/modules/nyaa';
import '../src/modules/keyframe';
import '../src/modules/mediaInfo';
import '../src/modules/airingDots';
import '../src/modules/anisongs';
import '../src/modules/tierLabels';
import '../src/modules/compareView';
import '../src/modules/sync';
import '../src/settings/devMode';
import legacyKeys from './fixtures/legacy-keys.json';
import { Settings, TYPES, ROWS, PREFIX, features } from '../src/settings/settings';
import { store, isDebug } from '../src/utils/helpers';
import { showPanel, closePanel, initSettingsPage } from '../src/settings/panel';
import { createModuleHost } from '../src/core/registry';
import type { SettingRow } from '../src/types';

// Snapshot initial registered key set before test-only Settings.register calls mutate ROWS.
const INITIAL_REGISTERED_KEYS = Object.keys(ROWS).sort();

describe('Settings: Type Normalizers (TYPES)', () => {
  describe('number normalizer', () => {
    const numRow: SettingRow = {
      key: 'testNum',
      type: 'number',
      def: 50,
      min: 0,
      max: 100,
      title: 'Test Number',
      help: 'Help',
      legacy: []
    };

    it('clamps values below min and above max', () => {
      expect(TYPES.number.normalize(-15, numRow)).toBe(0);
      expect(TYPES.number.normalize(150, numRow)).toBe(100);
      expect(TYPES.number.normalize(42, numRow)).toBe(42);
    });

    it('rounds floating point inputs to integers', () => {
      expect(TYPES.number.normalize(42.4, numRow)).toBe(42);
      expect(TYPES.number.normalize(42.6, numRow)).toBe(43);
    });

    it('falls back to default for null, undefined, empty strings, and NaN', () => {
      expect(TYPES.number.normalize(null, numRow)).toBe(50);
      expect(TYPES.number.normalize(undefined, numRow)).toBe(50);
      expect(TYPES.number.normalize('', numRow)).toBe(50);
      expect(TYPES.number.normalize('   ', numRow)).toBe(50);
      expect(TYPES.number.normalize('not-a-number', numRow)).toBe(50);
    });

    it('allows 0 when min is 0', () => {
      expect(TYPES.number.normalize(0, numRow)).toBe(0);
      expect(TYPES.number.normalize('0', numRow)).toBe(0);
    });
  });

  describe('toggle normalizer', () => {
    it('normalizes booleans, strings, and truthy/falsy inputs', () => {
      expect(TYPES.toggle.normalize(true)).toBe(true);
      expect(TYPES.toggle.normalize(false)).toBe(false);
      expect(TYPES.toggle.normalize('false')).toBe(false);
      expect(TYPES.toggle.normalize('true')).toBe(true);
      expect(TYPES.toggle.normalize(1)).toBe(true);
      expect(TYPES.toggle.normalize(0)).toBe(false);
      expect(TYPES.toggle.normalize(null)).toBe(false);
      expect(TYPES.toggle.normalize(undefined)).toBe(false);
    });
  });

  describe('select normalizer', () => {
    const selectRow: SettingRow = {
      key: 'testSelect',
      type: 'select',
      def: 'round',
      options: [
        ['ceil', 'Ceil'],
        ['round', 'Round'],
        ['floor', 'Floor']
      ],
      title: 'Rounding',
      help: 'Help',
      legacy: []
    };

    it('allows registered option keys', () => {
      expect(TYPES.select.normalize('ceil', selectRow)).toBe('ceil');
      expect(TYPES.select.normalize('round', selectRow)).toBe('round');
      expect(TYPES.select.normalize('floor', selectRow)).toBe('floor');
    });

    it('falls back to default on invalid options or bad types', () => {
      expect(TYPES.select.normalize('exact', selectRow)).toBe('round');
      expect(TYPES.select.normalize('', selectRow)).toBe('round');
      expect(TYPES.select.normalize(null, selectRow)).toBe('round');
    });
  });

  describe('list normalizer', () => {
    const listRow: SettingRow = {
      key: 'testList',
      type: 'list',
      def: ['SubsPlease', 'ToonsHub'],
      title: 'Providers',
      help: 'Help',
      legacy: []
    };

    it('splits and trims comma-separated strings', () => {
      expect(TYPES.list.normalize('SubsPlease,  Erai-raws , Judged', listRow)).toEqual([
        'SubsPlease',
        'Erai-raws',
        'Judged'
      ]);
    });

    it('filters out empty segments and whitespace', () => {
      expect(TYPES.list.normalize('A,,  ,B', listRow)).toEqual(['A', 'B']);
    });

    it('accepts arrays directly', () => {
      expect(TYPES.list.normalize(['CustomGroup'], listRow)).toEqual(['CustomGroup']);
    });

    it('falls back to default when input is empty or null', () => {
      expect(TYPES.list.normalize('', listRow)).toEqual(['SubsPlease', 'ToonsHub']);
      expect(TYPES.list.normalize(null, listRow)).toEqual(['SubsPlease', 'ToonsHub']);
      expect(TYPES.list.normalize([], listRow)).toEqual(['SubsPlease', 'ToonsHub']);
    });
  });

  describe('json normalizer', () => {
    const jsonRow: SettingRow = {
      key: 'testJson',
      type: 'json',
      def: { initial: true },
      title: 'JSON',
      help: 'Help',
      legacy: []
    };

    it('parses valid JSON strings and preserves objects', () => {
      expect(TYPES.json.normalize('{"custom": 123}', jsonRow)).toEqual({ custom: 123 });
      expect(TYPES.json.normalize({ already: 'object' }, jsonRow)).toEqual({ already: 'object' });
    });

    it('reverts to default on malformed JSON strings or null', () => {
      expect(TYPES.json.normalize('{bad_json', jsonRow)).toEqual({ initial: true });
      expect(TYPES.json.normalize(null, jsonRow)).toEqual({ initial: true });
    });

    it('applies custom row validation if defined', () => {
      const validatedRow: SettingRow = {
        ...jsonRow,
        validate: (v) => (Array.isArray(v) ? { valid: true, tiers: v } : { valid: false })
      };

      expect(TYPES.json.normalize([1, 2, 3], validatedRow)).toEqual([1, 2, 3]);
      expect(TYPES.json.normalize('not-an-array', validatedRow)).toEqual({ initial: true });
    });
  });
});

describe('Settings: Registry & Storage (Settings.get / Settings.set)', () => {
  beforeEach(() => {
    store.del(PREFIX + 'tagPercentage');
    store.del(PREFIX + 'syncScoreRounding');
  });

  it('reads registered default values when no custom setting is saved', () => {
    expect(Settings.get('tagPercentage')).toBe(50);
    expect(Settings.get('syncScoreRounding')).toBe('round');
  });

  it('persists and normalizes values when updated via Settings.set', () => {
    Settings.set('tagPercentage', 75);
    expect(Settings.get('tagPercentage')).toBe(75);
    expect(store.get(PREFIX + 'tagPercentage')).toBe(75);

    Settings.set('tagPercentage', 250);
    expect(Settings.get('tagPercentage')).toBe(100);
  });

  it('throws an error when querying an unregistered setting key', () => {
    expect(() => Settings.get('nonExistentKey')).toThrow('Unknown setting: nonExistentKey');
  });

  it('rejects registering duplicate keys in FeatureMeta', () => {
    expect(() =>
      Settings.register({
        id: 'duplicateTest',
        key: 'tagPercentage',
        title: 'Duplicate',
        help: 'Duplicate'
      })
    ).toThrow('Duplicate setting: tagPercentage');
  });
});

describe('Settings: Legacy Migration (Settings.migrate)', () => {
  const TEST_KEY = 'migrateTestSetting';

  beforeEach(() => {
    store.del(PREFIX + TEST_KEY);
    store.del(PREFIX + 'old_legacy_key');
    localStorage.removeItem('ALAdditions:old_legacy_key');
  });

  it('migrates legacy stored values into prefixed keys', () => {
    if (!ROWS[TEST_KEY]) {
      Settings.register({
        id: 'migrationFeature',
        key: TEST_KEY,
        type: 'number',
        def: 10,
        legacy: ['old_legacy_key'],
        title: 'Migrate Test',
        help: 'Help'
      });
    }

    store.set(PREFIX + 'old_legacy_key', 42);

    Settings.migrate();

    expect(Settings.get(TEST_KEY)).toBe(42);
  });

  it('migrates raw localStorage keys from ALAdditions namespace', () => {
    if (!ROWS[TEST_KEY]) {
      Settings.register({
        id: 'migrationFeature',
        key: TEST_KEY,
        type: 'number',
        def: 10,
        legacy: ['old_legacy_key'],
        title: 'Migrate Test',
        help: 'Help'
      });
    }

    localStorage.setItem('ALAdditions:old_legacy_key', JSON.stringify(77));

    Settings.migrate();

    expect(Settings.get(TEST_KEY)).toBe(77);
  });

  it('purges legacy al_token during Settings.migrate()', () => {
    store.set('al_token', 'legacy_oauth_token_val');
    Settings.migrate();
    expect(store.get('al_token', null)).toBeNull();
  });
});

describe('Settings: Legacy Key Parity & Registry Guarantees', () => {
  it('preserves all 33 legacy keys with exact schema and adds only manualOverridesEnabled (34 total)', () => {
    expect(legacyKeys).toHaveLength(33);
    for (const expected of legacyKeys) {
      const actual = ROWS[expected.key];
      expect(actual, `Missing setting row for key "${expected.key}"`).toBeDefined();
      expect(actual.type).toBe(expected.type);
      expect(actual.def).toEqual(expected.def);
      expect(actual.legacy).toEqual(expected.legacy);
    }

    const legacyKeySet = new Set(legacyKeys.map((k) => k.key));
    const addedKeys = INITIAL_REGISTERED_KEYS.filter((k) => !legacyKeySet.has(k));
    expect(addedKeys).toEqual(['manualOverridesEnabled']);
    expect(INITIAL_REGISTERED_KEYS).toHaveLength(34);
  });

  it('rolls back atomically when any option key collides during Settings.register', () => {
    const beforeFeatureCount = features.length;
    expect(() =>
      Settings.register({
        id: 'atomicRollbackTest',
        key: 'atomicUniqueToggleKey',
        title: 'Atomic Test',
        help: 'Atomic Test',
        options: [
          {
            key: 'atomicUniqueOptKey',
            type: 'toggle',
            def: false,
            title: 'Unique Option',
            help: 'Should roll back'
          },
          {
            key: 'tagPercentage',
            type: 'number',
            def: 10,
            title: 'Colliding Option',
            help: 'Collides'
          }
        ]
      })
    ).toThrow('Duplicate setting: tagPercentage');

    expect(ROWS.atomicUniqueToggleKey).toBeUndefined();
    expect(ROWS.atomicUniqueOptKey).toBeUndefined();
    expect(features).toHaveLength(beforeFeatureCount);
  });

  it('enforces mandatory def: false on toggles in register and registerCoreSetting', () => {
    expect(() =>
      Settings.register({
        id: 'badToggleDefault',
        key: 'badToggleKey',
        title: 'Bad',
        help: 'Bad',
        def: true as any
      })
    ).toThrow(/must default to false/);

    expect(() =>
      Settings.registerCoreSetting({
        key: 'badCoreToggleKey',
        type: 'toggle',
        def: true,
        title: 'Bad Core',
        help: 'Bad'
      })
    ).toThrow(/must default to false/);
  });

  it('normalizes standardized json validators via TYPES.json.normalize', () => {
    expect(TYPES.json.normalize('not valid json', ROWS.tierLabels)).toEqual(ROWS.tierLabels.def);
    expect(TYPES.json.normalize('not valid json', ROWS.aniSongsProviders)).toEqual(ROWS.aniSongsProviders.def);
    expect(TYPES.json.normalize('{"123":{"malId":-1}}', ROWS.syncManualOverrides)).toEqual(ROWS.syncManualOverrides.def);

    const validOverrides = {
      '101': { malId: 202, type: 'anime', title: ' Valid Title ', updatedAt: 123 }
    };
    const normalized = TYPES.json.normalize(validOverrides, ROWS.syncManualOverrides);
    expect(normalized).toEqual({
      '101': { malId: 202, type: 'ANIME', title: 'Valid Title', updatedAt: 123 }
    });
  });

  it('renders auto-ordered sections, alphabetical modules, Developer Mode, and live collapsible [data-debug-for]', () => {
    closePanel();
    const host = createModuleHost();
    showPanel(host);

    const sections = Array.from(document.querySelectorAll('#ala-settings-panel [data-section]')).map(
      (el) => (el as HTMLElement).dataset.section
    );
    expect(sections[0]).toBe('Sync');
    expect(sections.slice(-3)).toEqual(['Advanced', 'backup', 'credits']);

    const advCard = document.querySelector('#ala-settings-panel [data-section="Advanced"] [data-feature="devMode"]');
    expect(advCard).not.toBeNull();
    expect(advCard!.querySelector('input[data-key="debugGeneral"]')).not.toBeNull();

    const fastLoadDebugWrap = advCard!.querySelector<HTMLElement>('[data-debug-for="fastLoadEnabled"]');
    expect(fastLoadDebugWrap).not.toBeNull();
    expect(fastLoadDebugWrap!.classList.contains('is-open')).toBe(false);

    const flToggle = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="fastLoadEnabled"]')!;
    flToggle.checked = true;
    flToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fastLoadDebugWrap!.classList.contains('is-open')).toBe(true);

    closePanel();
  });

  it('registers dynamic debug channels and mutes without wiping preferences when devModeEnabled is off', () => {
    Settings.set('devModeEnabled', true);
    Settings.set('debugGeneral', true);
    Settings.set('debugFastLoad', true);

    expect(isDebug('general')).toBe(true);
    expect(isDebug('fastLoad')).toBe(true);
    expect(isDebug('sync')).toBe(false);

    Settings.set('devModeEnabled', false);
    expect(isDebug('general')).toBe(false);
    expect(isDebug('fastLoad')).toBe(false);
    expect(Settings.get('debugGeneral')).toBe(true);
    expect(Settings.get('debugFastLoad')).toBe(true);
  });

  it('restores pre-refactor section dropdown styling and shows "Save" without reloading when unchanged', () => {
    closePanel();
    const prevTag = Settings.get('tagFilterEnabled');
    const prevPct = Settings.get('tagPercentage');
    const prevNyaa = Settings.get('nyaaEnabled');
    const prevTier = Settings.get('tierLabelsEnabled');

    try {
      Settings.set('tagFilterEnabled', true);
      Settings.set('tagPercentage', 50);
      Settings.set('nyaaEnabled', true);
      Settings.set('tierLabelsEnabled', true);

      const host = createModuleHost();
      initSettingsPage(host);
      const styleText = document.getElementById('ala-settings-style')?.textContent || '';
      expect(styleText).toContain('#ala-settings-panel .ala-section-title{margin:18px 2px 8px;color:rgb(var(--color-blue));font-size:13px;font-weight:600}');
      expect(styleText).toContain('.ala-section-dropdown{margin-top:14px;border-radius:6px;background:rgb(var(--color-background));overflow:hidden;contain:paint}');
      expect(styleText).toContain('.ala-section-dropdown.is-expanded .ala-chevron{transform:rotate(180deg)}');

      showPanel(host);

      const saveBtn = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;
      const statusEl = document.querySelector<HTMLElement>('#ala-settings-panel .ala-status')!;
      const reloadSpy = vi.spyOn(host, 'reload');

      expect(saveBtn.textContent).toBe('Save');

      saveBtn.click();
      expect(reloadSpy).not.toHaveBeenCalled();
      expect(statusEl.textContent).toBe('Saved.');
      expect(saveBtn.textContent).toBe('Save');

      const pctInput = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="tagPercentage"]')!;
      pctInput.value = '65';
      pctInput.dispatchEvent(new Event('change', { bubbles: true }));
      expect(saveBtn.textContent).toBe('Save and reload');

      // Equivalent normalized value reverts Save plan back to no-op Save
      pctInput.value = '50';
      pctInput.dispatchEvent(new Event('change', { bubbles: true }));
      expect(saveBtn.textContent).toBe('Save');
    } finally {
      closePanel();
      Settings.set('tagFilterEnabled', prevTag);
      Settings.set('tagPercentage', prevPct);
      Settings.set('nyaaEnabled', prevNyaa);
      Settings.set('tierLabelsEnabled', prevTier);
    }
  });
});