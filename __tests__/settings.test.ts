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
import {
  store,
  createCoreLogger,
  isDebugEnabled
} from '../src/utils/helpers';
import { showPanel, closePanel, initSettingsPage } from '../src/settings/panel';
import { createModuleHost } from '../src/core/registry';
import type { SettingRow } from '../src/types';

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
  it('preserves all non-retired legacy keys with exact schema and registers consolidated debug + manualOverridesEnabled keys', () => {
    const RETIRED_LEGACY_KEYS = new Set([
      'debugGeneral',
      'debugFastLoad',
      'debugSync',
      'debugCompareView',
      'debugMediaInfo',
      'debugTierLabels'
    ]);
    expect(legacyKeys).toHaveLength(33);
    for (const expected of legacyKeys) {
      if (RETIRED_LEGACY_KEYS.has(expected.key)) {
        expect(ROWS[expected.key]).toBeUndefined();
        continue;
      }
      const actual = ROWS[expected.key];
      expect(actual, `Missing setting row for key "${expected.key}"`).toBeDefined();
      expect(actual.type).toBe(expected.type);
      expect(actual.def).toEqual(expected.def);
      expect(actual.legacy).toEqual(expected.legacy);
    }

    const legacyKeySet = new Set(legacyKeys.map((k) => k.key));
    const addedKeys = INITIAL_REGISTERED_KEYS.filter((k) => !legacyKeySet.has(k));
    expect(addedKeys).toEqual(['debug', 'manualOverridesEnabled']);
    expect(INITIAL_REGISTERED_KEYS).toHaveLength(29);
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

  it('supports Settings.has(), enforces def: false on all toggles, and rejects reserved "general" channels', () => {
    store.del(PREFIX + 'tagPercentage');
    expect(Settings.has('tagPercentage')).toBe(false);
    Settings.set('tagPercentage', 60);
    expect(Settings.has('tagPercentage')).toBe(true);
    expect(() => Settings.has('doesNotExist')).toThrow('Unknown setting: doesNotExist');

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

    expect(() =>
      Settings.register({
        id: 'badGeneralChan',
        key: 'badGeneralChanEnabled',
        title: 'Bad General',
        help: 'Bad',
        debug: {
          title: 'Bad General Debug',
          help: 'Help',
          channels: {
            General: { label: 'General', title: 'General', debug: true }
          }
        }
      })
    ).toThrow(/conflicts with reserved "general"/);
    expect(ROWS.badGeneralChanEnabled).toBeUndefined();
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

  it('renders 2-tier Core and Module Developer Mode debug groups, hides { debug: false } modules, and syncs nested debug state cleanly', () => {
    closePanel();
    Settings.set('devModeEnabled', false);
    Settings.set('fastLoadEnabled', false);
    Settings.set('debug', {});

    const host = createModuleHost();
    showPanel(host);

    const sections = Array.from(document.querySelectorAll('#ala-settings-panel [data-section]')).map(
      (el) => (el as HTMLElement).dataset.section
    );
    expect(sections[0]).toBe('Sync');
    expect(sections.slice(-3)).toEqual(['Advanced', 'backup', 'credits']);

    const advCard = document.querySelector('#ala-settings-panel [data-section="Advanced"] [data-feature="devMode"]')!;
    expect(advCard).not.toBeNull();

    for (const f of features) {
      if (!f.debug || f.debug.debug === false) {
        expect(advCard.querySelector(`[data-debug-for="${f.toggle.key}"]`)).toBeNull();
      }
    }

    const devToggle = advCard.querySelector<HTMLInputElement>('input[data-key="devModeEnabled"]')!;
    const debugHidden = advCard.querySelector<HTMLInputElement>('input[data-key="debug"]')!;
    const coreMaster = advCard.querySelector<HTMLInputElement>('input[data-debug-scope="core"]:not([data-debug-channel])')!;
    const coreChildWrap = advCard.querySelector<HTMLElement>('.ala-child-option[data-debug-children="core"]')!;
    const coreGen = advCard.querySelector<HTMLInputElement>('input[data-debug-scope="core"][data-debug-channel="general"]')!;
    const coreApi = advCard.querySelector<HTMLInputElement>('input[data-debug-scope="core"][data-debug-channel="anilist"]')!;
    expect(debugHidden).not.toBeNull();
    expect(coreMaster).not.toBeNull();
    expect(coreChildWrap.classList.contains('is-open')).toBe(false);
    expect(coreGen.disabled).toBe(true);

    devToggle.checked = true;
    devToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(coreMaster.disabled).toBe(false);
    expect(coreChildWrap.classList.contains('is-open')).toBe(false);

    coreMaster.checked = true;
    coreMaster.dispatchEvent(new Event('change', { bubbles: true }));
    expect(coreChildWrap.classList.contains('is-open')).toBe(true);
    expect(coreGen.disabled).toBe(false);
    expect(JSON.parse(debugHidden.value).core.enabled).toBe(true);

    coreApi.checked = false;
    coreApi.dispatchEvent(new Event('change', { bubbles: true }));
    expect(JSON.parse(debugHidden.value).core.channels.anilist).toBe(false);

    const flDebugWrap = advCard.querySelector<HTMLElement>('[data-debug-for="fastLoadEnabled"]')!;
    const flMaster = flDebugWrap.querySelector<HTMLInputElement>('input[data-debug-scope="fastLoad"]:not([data-debug-channel])')!;
    const flChildWrap = flDebugWrap.querySelector<HTMLElement>('.ala-child-option[data-debug-children="fastLoad"]')!;
    const flMain = flDebugWrap.querySelector<HTMLInputElement>('input[data-debug-scope="fastLoad"][data-debug-channel="general"]')!;
    const flRpc = flDebugWrap.querySelector<HTMLInputElement>('input[data-debug-scope="fastLoad"][data-debug-channel="rpc"]')!;

    expect(flDebugWrap.classList.contains('is-open')).toBe(false);
    expect(flMaster.disabled).toBe(true);
    expect(flMain.disabled).toBe(true);
    expect(flRpc.disabled).toBe(true);

    const flToggle = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="fastLoadEnabled"]')!;
    flToggle.checked = true;
    flToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(flDebugWrap.classList.contains('is-open')).toBe(true);
    expect(flMaster.disabled).toBe(false);
    expect(flChildWrap.classList.contains('is-open')).toBe(false);
    expect(flRpc.disabled).toBe(true);

    flMaster.checked = true;
    flMaster.dispatchEvent(new Event('change', { bubbles: true }));
    expect(flChildWrap.classList.contains('is-open')).toBe(true);
    expect(flMain.disabled).toBe(false);
    expect(flRpc.disabled).toBe(false);
    expect(JSON.parse(debugHidden.value).fastLoad.enabled).toBe(true);

    document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-reset')!.click();
    expect(coreMaster.checked).toBe(false);
    expect(coreApi.checked).toBe(true);
    expect(coreChildWrap.classList.contains('is-open')).toBe(false);
    expect(flMaster.checked).toBe(false);
    expect(flChildWrap.classList.contains('is-open')).toBe(false);
    expect(JSON.parse(debugHidden.value).core.enabled).toBe(false);

    flToggle.checked = false;
    flToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(flDebugWrap.classList.contains('is-open')).toBe(false);
    expect(flChildWrap.classList.contains('is-open')).toBe(false);
    expect(flRpc.disabled).toBe(true);

    devToggle.checked = false;
    devToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(coreChildWrap.classList.contains('is-open')).toBe(false);
    expect(coreGen.disabled).toBe(true);

    closePanel();
  });

  it('gates createCoreLogger on devModeEnabled + debug.core + channel toggle without wiping preferences', () => {
    const coreLog = createCoreLogger('core');
    const apiLog = createCoreLogger('anilist');

    Settings.set('devModeEnabled', true);
    Settings.set('debug', {
      core: {
        enabled: true,
        channels: { general: true, settings: true, anilist: false, mal: true }
      }
    });

    expect(coreLog.enabled()).toBe(true);
    expect(apiLog.enabled()).toBe(false);
    expect(isDebugEnabled('fastLoad', 'general')).toBe(false);

    Settings.set('devModeEnabled', false);
    expect(coreLog.enabled()).toBe(false);
    expect(Settings.get('debug').core.enabled).toBe(true);
    expect(Settings.get('debug').core.channels.general).toBe(true);
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

describe('Settings: B1-21 Regression Guards', () => {
  it('rejects Object.prototype keys in Settings.get and Settings.set without touching storage', () => {
    const gmSetSpy = globalThis.GM_setValue as ReturnType<typeof vi.fn>;
    for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      gmSetSpy.mockClear();
      expect(() => Settings.get(key)).toThrow(`Unknown setting: ${key}`);
      expect(() => Settings.set(key, 1)).toThrow(`Unknown setting: ${key}`);
      expect(gmSetSpy).not.toHaveBeenCalled();
      expect(store.get(PREFIX + key, '__MISSING__')).toBe('__MISSING__');
    }
  });

  it('writes nothing on Settings.set for unknown keys and fires store.watch once with normalized value on valid set', () => {
    const gmSetSpy = globalThis.GM_setValue as ReturnType<typeof vi.fn>;
    gmSetSpy.mockClear();

    expect(() => Settings.set('unknown', 1)).toThrow('Unknown setting: unknown');
    expect(gmSetSpy).not.toHaveBeenCalled();
    expect(store.get(PREFIX + 'unknown', '__MISSING__')).toBe('__MISSING__');

    const watched: Array<{ oldVal: any; newVal: any }> = [];
    const unwatch = store.watch(PREFIX + 'tagPercentage', (_k, oldVal, newVal) => {
      watched.push({ oldVal, newVal });
    });
    try {
      Settings.set('tagPercentage', 250);
      expect(watched).toEqual([{ oldVal: undefined, newVal: 100 }]);
      expect(store.get(PREFIX + 'tagPercentage')).toBe(100);
    } finally {
      unwatch();
      store.del(PREFIX + 'tagPercentage');
    }
  });

  it('deep-clones JSON defaults so mutating Settings.get() or fallback results never mutates ROWS.*.def', () => {
    const firstTiers = Settings.get('tierLabels');
    expect(firstTiers).not.toBe(ROWS.tierLabels.def);
    firstTiers[0].label = 'MUTATED';
    firstTiers.push({ min: 0, max: 1, label: 'EXTRA', color: '#000000', textColor: '#ffffff' });

    expect(ROWS.tierLabels.def[0].label).toBe('S+');
    expect(ROWS.tierLabels.def).toHaveLength(7);
    expect(Settings.get('tierLabels')[0].label).toBe('S+');

    const providers = Settings.get('aniSongsProviders');
    providers.active.push('youtube');
    providers.presets[0].name = 'MUTATED';
    expect(ROWS.aniSongsProviders.def.active).toEqual([]);
    expect(ROWS.aniSongsProviders.def.presets[0].name).toBe('YouTube');

    const tempKey = 'tempJsonCloneTest';
    const tempDef = { nested: { items: [1, 2] } };
    Settings.registerCoreSetting({
      key: tempKey,
      type: 'json',
      def: tempDef,
      title: 'Temp JSON',
      help: 'Help'
    });
    try {
      const val = Settings.get(tempKey);
      expect(val).toEqual(tempDef);
      expect(val).not.toBe(tempDef);
      val.nested.items.push(3);
      expect(tempDef.nested.items).toEqual([1, 2]);
      expect(Settings.get(tempKey)).toEqual({ nested: { items: [1, 2] } });
    } finally {
      delete ROWS[tempKey];
      store.del(PREFIX + tempKey);
    }
  });

  it('catches throwing JSON validators and returns cloned default', () => {
    const row: SettingRow = {
      key: 'throwingJson',
      type: 'json',
      def: { safe: [1] },
      title: 'Throwing JSON',
      help: 'Help',
      legacy: [],
      validate: () => {
        throw new Error('validator exploded');
      }
    };

    const res = TYPES.json.normalize({ any: 'value' }, row);
    expect(res).toEqual({ safe: [1] });
    expect(res).not.toBe(row.def);
    res.safe.push(2);
    expect(row.def.safe).toEqual([1]);

    const badInput = document.createElement('input');
    badInput.value = '{bad';
    badInput.dataset.key = 'toString';
    expect(TYPES.json.read(badInput)).toBeUndefined();
  });

  it('rejects booleans, objects, arrays, and non-finite inputs in TYPES.number and invalid values/items in TYPES.list', () => {
    const numRow: SettingRow = {
      key: 'numGuard',
      type: 'number',
      def: 50,
      min: 0,
      max: 100,
      title: 'Num',
      help: 'Help',
      legacy: []
    };
    for (const bad of [true, false, {}, [], [42], NaN, Infinity, -Infinity, 'Infinity']) {
      expect(TYPES.number.normalize(bad, numRow)).toBe(50);
    }

    const listRow: SettingRow = {
      key: 'listGuard',
      type: 'list',
      def: ['SubsPlease', 'ToonsHub'],
      title: 'List',
      help: 'Help',
      legacy: []
    };
    for (const bad of [{}, { length: 1 }, true, false, 123, [null, {}], [NaN, Infinity, true]]) {
      const normalized = TYPES.list.normalize(bad, listRow);
      expect(normalized).toEqual(['SubsPlease', 'ToonsHub']);
      expect(normalized).not.toBe(listRow.def);
    }
    expect(TYPES.list.normalize(['A', 42, 0, null, {}, [], true, undefined, NaN, '  ', 'B'], listRow)).toEqual([
      'A',
      '42',
      '0',
      'B'
    ]);
  });
});