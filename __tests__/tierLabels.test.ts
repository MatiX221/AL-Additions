import { describe, it, expect, vi, afterEach } from 'vitest';
import '../src/modules/tierLabels';
import {
  DEFAULT_TIERS,
  getTier,
  validateTiers,
  isValidColor,
  normalizeHexColor,
  cssColorToHex,
  type TierConfig
} from '../src/modules/tierLabels/tiers';
import { openTierEditor } from '../src/modules/tierLabels/tierModal';
import { getValidTiers } from '../src/modules/tierLabels';
import { Settings } from '../src/settings/settings';
import { runMigrations, bootModuleForTest, disposeFeature, createModuleHost } from '../src/core/registry';
import { store } from '../src/utils/helpers';
import type { JsonEditorContext, ModalOptions, ModalHandle } from '../src/types';

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

function createTierEditorCtx(value: unknown, onApply = vi.fn()): {
  ec: JsonEditorContext;
  closeSpy: ReturnType<typeof vi.fn>;
  backdrop: HTMLDivElement;
} {
  let modalHandle: ModalHandle | null = null;
  const edAc = new AbortController();
  const modalAc = new AbortController();
  const modalCleanups: Array<() => void> = [];
  const closeSpy = vi.fn(() => {
    modalAc.abort();
    modalHandle?.backdrop.remove();
    for (const fn of modalCleanups.splice(0)) fn();
  });
  const ec: JsonEditorContext = {
    value,
    onApply,
    signal: edAc.signal,
    getId: (name = 'ed') => `ala-test-${name}`,
    addStyle: vi.fn(() => () => {}) as any,
    listen: vi.fn(() => () => {}),
    timeout: vi.fn((fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    }),
    observe: vi.fn(() => () => {}),
    onCleanup: vi.fn(),
    modal: (opts: ModalOptions): ModalHandle => {
      const modalId = `ala-modal-${opts.id || 'test'}`;
      const backdrop = document.createElement('div');
      backdrop.id = modalId;
      backdrop.innerHTML = `
        <div class="ala-core-sheet">
          <div class="ala-core-body">${opts.bodyHtml || ''}</div>
          <div class="ala-core-foot">${opts.footerHtml || ''}</div>
        </div>
      `;
      backdrop.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (e.target === backdrop || target?.closest('[data-ala-close]')) closeSpy();
      });
      document.body.appendChild(backdrop);
      modalHandle = {
        id: modalId,
        selector: `#${modalId}`,
        signal: modalAc.signal,
        backdrop,
        sheet: backdrop.querySelector('.ala-core-sheet') as HTMLElement,
        body: backdrop.querySelector('.ala-core-body') as HTMLElement,
        footer: backdrop.querySelector('.ala-core-foot') as HTMLElement,
        close: closeSpy,
        listen: (target, type, listener, opts) => {
          target.addEventListener(type, listener, opts);
          const off = () => target.removeEventListener(type, listener, opts);
          modalCleanups.push(off);
          return off;
        },
        timeout: vi.fn(() => () => {}),
        onCleanup: (fn) => modalCleanups.push(fn)
      };
      return modalHandle;
    },
    confirm: vi.fn().mockResolvedValue(true),
    alert: vi.fn().mockResolvedValue(undefined),
    toast: {
      show: vi.fn(),
      success: vi.fn(),
      error: vi.fn()
    }
  };
  return {
    ec,
    closeSpy,
    get backdrop() {
      return modalHandle!.backdrop;
    }
  };
}

describe('Tier Labels: Cycle 1 Regressions (BUG-80..BUG-82)', () => {
  afterEach(() => {
    disposeFeature('tierLabels');
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('BUG-80: samples target compare column separately from viewer column even without label attributes', async () => {
    Settings.set('tierLabels', DEFAULT_TIERS);
    Settings.set('tierLabelsEnabled', true);
    store.set('ala_mod_tierLabels_standalone_seen', false);
    store.set('al_score_format', 'POINT_100');

    document.body.innerHTML = `
      <div class="compare">
        <div class="entry">
          <div class="title">Show A</div>
          <div class="score" score="85">85</div>
          <div class="score" score="8">8</div>
        </div>
        <div class="entry">
          <div class="title">Show B</div>
          <div class="score" score="95">95</div>
          <div class="score" score="9">9</div>
        </div>
      </div>
    `;

    await bootModuleForTest('tierLabels');

    const entries = document.querySelectorAll<HTMLElement>('.compare .entry');
    const targetA = entries[0].querySelectorAll<HTMLElement>('.score')[1];
    const targetB = entries[1].querySelectorAll<HTMLElement>('.score')[1];

    // POINT_10 target: 8 -> 80 (A), 9 -> 90 (S); if misclassified as POINT_100 they would be F
    expect(targetA.querySelector('.ala-tier-badge')?.textContent).toBe('A');
    expect(targetB.querySelector('.ala-tier-badge')?.textContent).toBe('S');
  });

  it('BUG-80: distinguishes POINT_3 smiley icons from POINT_5 star icons in compare view', async () => {
    Settings.set('tierLabels', DEFAULT_TIERS);
    Settings.set('tierLabelsEnabled', true);
    store.set('ala_mod_tierLabels_standalone_seen', false);
    store.set('al_score_format', 'POINT_100');

    document.body.innerHTML = `
      <div class="compare" id="cmp-smiley">
        <div class="entry">
          <div class="title">Smiley Good</div>
          <div class="score" label="Score" score="90">90</div>
          <div class="score" label="Bob's Score" score="3"><svg data-icon="smile" class="fa-smile"></svg></div>
        </div>
        <div class="entry">
          <div class="title">Smiley Meh</div>
          <div class="score" label="Score" score="70">70</div>
          <div class="score" label="Bob's Score" score="2"><svg data-icon="meh" class="fa-meh"></svg></div>
        </div>
      </div>
      <div class="compare" id="cmp-star">
        <div class="entry">
          <div class="title">Star Three</div>
          <div class="score" label="Score" score="90">90</div>
          <div class="score" label="Alice's Score" score="3"><svg data-icon="star" class="fa-star"></svg></div>
        </div>
      </div>
    `;

    await bootModuleForTest('tierLabels');

    const smileyScores = document.querySelectorAll<HTMLElement>('#cmp-smiley .entry .score[label="Bob\'s Score"]');
    expect(smileyScores[0].querySelector('.ala-tier-badge')?.textContent).toBe('S+');
    expect(smileyScores[1].querySelector('.ala-tier-badge')?.textContent).toBe('C');

    const starScore = document.querySelector<HTMLElement>('#cmp-star .entry .score[label="Alice\'s Score"]')!;
    expect(starScore.querySelector('.ala-tier-badge')?.textContent).toBe('C');
  });

  it('BUG-81: unwraps injected tier DOM badges when standalone script is detected and cancels pending mutation timers', async () => {
    Settings.set('tierLabels', DEFAULT_TIERS);
    Settings.set('tierLabelsEnabled', true);
    store.set('ala_mod_tierLabels_standalone_seen', false);
    store.set('al_score_format', 'POINT_10');

    document.body.innerHTML = `
      <div class="score" score="9">9</div>
      <div class="row score">
        <div class="percentage">85%<div class="sub-row popularity">#10</div></div>
      </div>
    `;

    // Simulate standalone script marking the hidden probe element when added
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node instanceof HTMLElement && node.hasAttribute('data-ala-probe')) {
            node.setAttribute('data-tier-modified', 'true');
          }
        }
      }
    });
    observer.observe(document.body, { childList: true });

    try {
      await bootModuleForTest('tierLabels');

      // Initial synchronous runScan injected badges before probe resolved
      const scoreEl = document.querySelector<HTMLElement>('.score')!;
      const pctEl = document.querySelector<HTMLElement>('.row.score .percentage')!;
      expect(scoreEl.querySelector('.ala-tier-container')).not.toBeNull();
      expect(pctEl.querySelector('.ala-tier-container')).not.toBeNull();

      // Trigger extra DOM mutations while probe is running
      const lateScore = document.createElement('div');
      lateScore.className = 'score';
      lateScore.setAttribute('score', '8');
      lateScore.textContent = '8';
      document.body.appendChild(lateScore);

      // Wait for probeTierLabels() (50ms poll) to detect standalone script and yield
      await new Promise((r) => setTimeout(r, 120));

      expect(createModuleHost().getStatus('tierLabels')).toEqual({ active: false, reason: 'standalone-paused' });
      expect(document.querySelectorAll('.ala-tier-container').length).toBe(0);
      expect(document.querySelectorAll('.ala-tier-badge').length).toBe(0);
      expect(scoreEl.dataset.tierModified).toBeUndefined();
      expect(scoreEl.dataset.tierSource).toBeUndefined();
      expect(scoreEl.textContent?.trim()).toBe('9');
      expect(pctEl.dataset.tierModified).toBeUndefined();
      expect(pctEl.querySelector('.sub-row.popularity')?.textContent).toBe('#10');
      expect(pctEl.textContent).toContain('85%');

      // Ensure cancelled mutation timer does not re-apply badges later
      await new Promise((r) => setTimeout(r, 140));
      expect(document.querySelectorAll('.ala-tier-container').length).toBe(0);
      expect(lateScore.dataset.tierModified).toBeUndefined();
    } finally {
      observer.disconnect();
    }
  });

  it('BUG-82: converts CSS colors to hex cleanly and rejects blank inputs instead of coercing defaults', () => {
    expect(cssColorToHex('#abc')).toBe('#aabbcc');
    expect(cssColorToHex('#ff000080')).toBe('#ff0000');
    expect(cssColorToHex('gold')).toBe('#ffd700');
    expect(cssColorToHex('rgb(255, 128, 0)')).toBe('#ff8000');
    expect(cssColorToHex('hsl(120, 100%, 50%)')).toBe('#00ff00');
    expect(cssColorToHex('transparent')).toBeNull();

    const onApply = vi.fn();
    const editorCtx = createTierEditorCtx(
      [{ min: 80, max: 100, label: 'S', color: 'gold', textColor: 'rgb(17, 34, 51)' }],
      onApply
    );
    openTierEditor(editorCtx.ec);
    const { closeSpy, backdrop } = editorCtx;

    const row = backdrop.querySelector<HTMLTableRowElement>('#ala-tier-tbody tr')!;
    const labelInput = row.querySelector<HTMLInputElement>('.ala-t-label')!;
    const minInput = row.querySelector<HTMLInputElement>('.ala-t-min')!;
    const maxInput = row.querySelector<HTMLInputElement>('.ala-t-max')!;
    const colorInput = row.querySelector<HTMLInputElement>('.ala-t-color')!;
    const textColorInput = row.querySelector<HTMLInputElement>('.ala-t-text-color')!;
    const saveBtn = backdrop.querySelector<HTMLButtonElement>('#ala-tier-btn-save')!;
    const status = backdrop.querySelector<HTMLElement>('#ala-tier-status')!;

    expect(colorInput.value).toBe('#ffd700');
    expect(textColorInput.value).toBe('#112233');

    // Blank label must fail validation instead of coercing to "Tier"
    labelInput.value = '   ';
    saveBtn.click();
    expect(onApply).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(status.classList.contains('is-error')).toBe(true);

    // Blank min must fail validation instead of coercing to 0
    labelInput.value = 'Top';
    minInput.value = '';
    saveBtn.click();
    expect(onApply).not.toHaveBeenCalled();
    expect(status.classList.contains('is-error')).toBe(true);

    // Blank max must fail validation instead of coercing to 100
    minInput.value = '80';
    maxInput.value = '';
    saveBtn.click();
    expect(onApply).not.toHaveBeenCalled();
    expect(status.classList.contains('is-error')).toBe(true);

    // Valid edit without touching color pickers preserves non-hex CSS colors ("gold", "rgb(17, 34, 51)")
    maxInput.value = '100';
    saveBtn.click();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith([
      { min: 80, max: 100, label: 'Top', color: 'gold', textColor: 'rgb(17, 34, 51)' }
    ]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('BUG-82: preserves exotic CSS colors unless user explicitly changes the color input', () => {
    const onApply = vi.fn();
    const editorCtx = createTierEditorCtx(
      [{ min: 0, max: 100, label: 'Custom', color: 'rgba(10, 20, 30, 0.5)', textColor: '#12345680' }],
      onApply
    );
    openTierEditor(editorCtx.ec);
    const { backdrop } = editorCtx;

    const row = backdrop.querySelector<HTMLTableRowElement>('#ala-tier-tbody tr')!;
    const colorInput = row.querySelector<HTMLInputElement>('.ala-t-color')!;
    const textColorInput = row.querySelector<HTMLInputElement>('.ala-t-text-color')!;
    const saveBtn = backdrop.querySelector<HTMLButtonElement>('#ala-tier-btn-save')!;

    // Explicitly change badge color via color picker
    colorInput.value = '#334455';
    colorInput.dispatchEvent(new Event('input', { bubbles: true }));

    saveBtn.click();
    expect(onApply).toHaveBeenCalledWith([
      { min: 0, max: 100, label: 'Custom', color: '#334455', textColor: '#12345680' }
    ]);
    expect(textColorInput.value).toBe('#123456');
  });
});

describe('Tier Labels: Cycle 2 Regressions (BUG-48)', () => {
  afterEach(() => {
    disposeFeature('tierLabels');
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('BUG-48: clears stale .ala-tier-container and dataset flags when a processed cell score attribute mutates to 0, -, or empty', async () => {
    vi.useFakeTimers();
    Settings.set('tierLabels', DEFAULT_TIERS);
    Settings.set('tierLabelsEnabled', true);
    store.set('ala_mod_tierLabels_standalone_seen', false);
    store.set('al_score_format', 'POINT_10');

    document.body.innerHTML = `
      <div class="list-entries">
        <div class="score" score="9">9</div>
      </div>
    `;

    await bootModuleForTest('tierLabels');

    const scoreEl = document.querySelector<HTMLElement>('.score')!;
    const triggerRescan = async () => {
      const marker = document.createElement('span');
      document.body.appendChild(marker);
      marker.remove();
      await vi.advanceTimersByTimeAsync(200);
    };

    expect(scoreEl.dataset.tierModified).toBe('true');
    expect(scoreEl.dataset.tierSource).toBe('9');
    expect(scoreEl.querySelector('.ala-tier-container')).not.toBeNull();
    expect(scoreEl.querySelector('.ala-tier-badge')?.textContent).toBe('S');

    for (const nextScore of ['0', '-', ''] as const) {
      // Re-apply a valid score first when testing '-' and '' so each transition starts from a processed '9' cell
      if (nextScore !== '0') {
        scoreEl.setAttribute('score', '9');
        await triggerRescan();
        expect(scoreEl.dataset.tierModified).toBe('true');
        expect(scoreEl.dataset.tierSource).toBe('9');
        expect(scoreEl.querySelector('.ala-tier-container')).not.toBeNull();
      }

      scoreEl.setAttribute('score', nextScore);
      await triggerRescan();

      expect(scoreEl.querySelector('.ala-tier-container')).toBeNull();
      expect(scoreEl.querySelector('.ala-tier-badge')).toBeNull();
      expect(scoreEl.dataset.tierModified).toBeUndefined();
      expect(scoreEl.dataset.tierSource).toBeUndefined();
      expect(scoreEl.textContent).toBe(nextScore);
    }
  });
});
