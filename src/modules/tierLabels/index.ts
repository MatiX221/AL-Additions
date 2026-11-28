import { defineModule } from '../../core/registry';
import type { MigrateContext } from '../../types';
import { sleep } from '../../utils/helpers';
import { PROBE_ATTR, DEFAULT_TIERS, getTier, validateTiers, type TierConfig } from './tiers';
import { openTierEditor } from './tierModal';

export { DEFAULT_TIERS, getTier, validateTiers, type TierConfig };

export function getValidTiers(raw?: unknown): TierConfig[] {
  if (raw === undefined) return DEFAULT_TIERS;
  const check = validateTiers(raw);
  return check.valid && check.tiers ? check.tiers : DEFAULT_TIERS;
}

function migrateLegacyTierLabels(m: MigrateContext): void {
  try {
    // @migration(from: "v0.8.0", kind: "import", sunset: "keep-long")
    const legacy = m.legacy.getLocal('anilistTierLabelsSettings');
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed.tiers) && parsed.tiers.length && !m.settings.has('tierLabels')) {
        const check = validateTiers(parsed.tiers);
        if (check.valid && check.tiers) {
          m.settings.set('tierLabels', check.tiers);
        }
      }
      if (typeof parsed.enableRatingTextColor === 'boolean' && !m.settings.has('tierLabelsColorScore')) {
        m.settings.set('tierLabelsColorScore', parsed.enableRatingTextColor);
      }
    }
  } catch (_) {}

  try {
    // @migration(from: "v0.9.1", kind: "storage", sunset: "2-3 releases")
    const legacySeen = m.legacy.get<boolean | null>('ala_standalone_seen_tierLabels', null);
    if (legacySeen !== null) {
      if (m.storage.get<boolean | null>('standalone_seen', null) === null) {
        m.storage.set('standalone_seen', !!legacySeen);
      }
      m.legacy.del('ala_standalone_seen_tierLabels');
    }
  } catch (_) {}
}

let probeCache: { at: number; result: Promise<boolean> } | null = null;

function probeTierLabels(timeoutMs = 600): Promise<boolean> {
  if (probeCache && Date.now() - probeCache.at < 30_000) return probeCache.result;
  const result = (async () => {
    if (!document.body) return false;
    const probe = document.createElement('div');
    probe.className = 'score';
    probe.hidden = true;
    probe.setAttribute('score', '9');
    probe.setAttribute(PROBE_ATTR, '1');
    probe.textContent = '9';
    document.body.appendChild(probe);
    try {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        await sleep(50);
        if (probe.hasAttribute('data-tier-modified')) return true;
      }
      return false;
    } finally {
      probe.remove();
    }
  })();
  probeCache = { at: Date.now(), result };
  return result;
}

defineModule({
  id: 'tierLabels',
  key: 'tierLabelsEnabled',
  section: 'AniList Enhancements',
  layer: 'feature',
  requiresReload: true,
  legacy: ['tierLabelsEnabled'],
  title: 'AniList Tier Labels',
  help: 'Adds customizable tier badges (S+, S, A, etc.) next to ratings across list, card, browse, and compare views.',
  debug: {
    label: 'Tier Labels',
    title: 'Tier Labels Debug',
    help: 'Log scoring system detection, tier matching, and badge rendering.'
  },
  standalone: {
    name: 'AniList Tier Labels',
    probe: () => probeTierLabels()
  },
  options: [
    {
      key: 'tierLabelsColorScore',
      type: 'toggle',
      def: true,
      title: 'Color score value',
      help: 'Color the score number text to match its tier badge.'
    },
    {
      key: 'tierLabelsAverageScore',
      type: 'toggle',
      def: false,
      title: 'Show on Weighted Score',
      help: 'Display tier badge next to the Weighted Score on media pages.'
    },
    {
      key: 'tierLabels',
      type: 'json',
      def: DEFAULT_TIERS,
      title: 'Tier Ranges & Colors',
      help: 'Customize score ranges, badge labels, and colors.',
      validate: validateTiers,
      editor: openTierEditor
    }
  ],
  migrate: migrateLegacyTierLabels,
  setup(ctx) {
    ctx.addStyle(`
      .ala-tier-badge {
        display: inline-block;
        font-weight: 700;
        border-radius: 4px;
        vertical-align: middle;
        white-space: nowrap;
        line-height: 1.2;
        box-sizing: border-box;
      }
      .ala-tier-badge--list {
        font-size: 11px;
        padding: 2px 5px;
        margin-left: 5px;
      }
      .ala-tier-badge--block {
        font-size: 10px;
        padding: 1px 4px;
        margin-left: 4px;
      }
      .ala-tier-container {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .ala-tier-container--block {
        background-color: rgba(0, 0, 0, 0.55);
        padding: 2px 6px;
        border-radius: 4px;
        overflow: hidden;
      }
      `
    );

    function createBadge(tier: TierConfig, isBlockView = false): HTMLElement {
      const badge = document.createElement('span');
      badge.className = `ala-tier-badge ${isBlockView ? 'ala-tier-badge--block' : 'ala-tier-badge--list'}`;
      badge.textContent = tier.label;
      badge.style.backgroundColor = tier.color;
      badge.style.color = tier.textColor;
      return badge;
    }

    function getScoreSystem(viewerScoreFormat: string | null): string {
      const container = document.querySelector('.content.container, .medialist');
      if (container) {
        if (container.querySelector('.medialist.table.POINT_100, .medialist.POINT_100')) return 'POINT_100';
        if (container.querySelector('.medialist.table.POINT_10_DECIMAL, .medialist.POINT_10_DECIMAL')) {
          return 'POINT_10_DECIMAL';
        }
        if (container.querySelector('.medialist.table.POINT_10, .medialist.POINT_10')) return 'POINT_10';
        if (container.querySelector('.medialist.table.POINT_5, .medialist.POINT_5')) return 'POINT_5';
        if (container.querySelector('.medialist.table.POINT_3, .medialist.POINT_3')) return 'POINT_3';
      }
      if (viewerScoreFormat) return viewerScoreFormat;
      return 'UNKNOWN';
    }

    function getCompareColumnFormat(el: HTMLElement, viewerScoreFormat: string | null): string {
      const compareRoot = el.closest('.compare') as (HTMLElement & { _colFormats?: Record<string, string> }) | null;
      if (!compareRoot) return 'UNKNOWN';

      const label = el.getAttribute('label') || '';
      const entry = el.closest('.entry');
      const entryScores = entry ? Array.from(entry.querySelectorAll<HTMLElement>('.score')) : [];
      const hasScoreLabel = entryScores.some((s) => s.getAttribute('label') === 'Score');
      const isAuthUser =
        label === 'Score' ||
        (!hasScoreLabel && (label ? entryScores.length >= 2 && entryScores[0] === el : entryScores[0] === el));
      const sideKey = isAuthUser ? 'auth' : 'target';

      if (!compareRoot._colFormats) compareRoot._colFormats = {};
      if (compareRoot._colFormats[sideKey]) return compareRoot._colFormats[sideKey];

      if (isAuthUser && viewerScoreFormat) {
        compareRoot._colFormats[sideKey] = viewerScoreFormat;
        return viewerScoreFormat;
      }

      const entries = compareRoot.querySelectorAll<HTMLElement>('.entry');
      let cells: HTMLElement[] = [];
      if (entries.length > 0) {
        for (const row of entries) {
          const rowScores = Array.from(row.querySelectorAll<HTMLElement>('.score'));
          if (rowScores.length === 0) continue;
          const labeledAuth = rowScores.find((s) => s.getAttribute('label') === 'Score');
          if (isAuthUser) {
            const cell = labeledAuth || (rowScores[0].hasAttribute('label') ? null : rowScores[0]);
            if (cell) cells.push(cell);
          } else {
            const cell = labeledAuth
              ? rowScores.find((s) => s !== labeledAuth)
              : rowScores[1] || (rowScores[0].getAttribute('label') ? rowScores[0] : null);
            if (cell) cells.push(cell);
          }
        }
      } else {
        const fallbackSelector = isAuthUser ? '.score[label="Score"]' : '.score:not([label="Score"])';
        cells = Array.from(compareRoot.querySelectorAll<HTMLElement>(fallbackSelector));
      }

      let maxScore = 0;
      let hasDecimal = false;
      let hasStarIcon = false;
      let hasSmileyIcon = false;

      for (const cell of cells) {
        const icons = cell.querySelectorAll<Element>('svg, .icon, [data-icon]');
        if (icons.length > 0) {
          let cellIsSmiley = false;
          const cellClass = (cell.getAttribute('class') || '').toLowerCase();
          if (/(?:point_3|smiley)/.test(cellClass)) {
            cellIsSmiley = true;
          } else {
            for (const icon of icons) {
              const sig = [
                icon.getAttribute('data-icon') || '',
                icon.getAttribute('class') || '',
                icon.getAttribute('aria-label') || '',
                icon.getAttribute('title') || ''
              ]
                .join(' ')
                .toLowerCase();
              if (/(?:smile|smiley|meh|frown)/.test(sig)) {
                cellIsSmiley = true;
                break;
              }
            }
          }
          if (cellIsSmiley) hasSmileyIcon = true;
          else hasStarIcon = true;
        }
        const s = cell.getAttribute('score') || (cell.textContent || '').replace('%', '').trim();
        const num = parseFloat(s);
        if (!isNaN(num) && num > 0) {
          if (num > maxScore) maxScore = num;
          if (s.includes('.')) hasDecimal = true;
        }
      }

      let detected = 'UNKNOWN';
      if (maxScore > 10) detected = 'POINT_100';
      else if (hasDecimal) detected = 'POINT_10_DECIMAL';
      else if (hasStarIcon) detected = 'POINT_5';
      else if (hasSmileyIcon && maxScore <= 3) detected = 'POINT_3';
      else if (hasSmileyIcon) detected = 'POINT_5';
      else if (maxScore > 5) detected = 'POINT_10';
      else if (maxScore > 0) detected = 'POINT_10';

      compareRoot._colFormats[sideKey] = detected;
      ctx.log.debug(`Detected score system for ${isAuthUser ? 'viewer' : 'other'}:`, detected, {
        maxScore,
        hasDecimal,
        hasStarIcon,
        hasSmileyIcon
      });
      return detected;
    }

    function normalizeScore(score: number, scoreSystem: string, isPercentage = false): number | null {
      if (isNaN(score) || score <= 0) return null;
      if (isPercentage) return score;

      switch (scoreSystem) {
        case 'POINT_100':
          return score;
        case 'POINT_10_DECIMAL':
        case 'POINT_10':
          return score * 10;
        case 'POINT_5':
          return score * 20;
        case 'POINT_3':
          return score === 3 ? 100 : score === 2 ? 60 : 20;
        default:
          return score > 10 ? score : score * 10;
      }
    }

    function clearProcessedCell(el: HTMLElement, fallbackText = ''): void {
      const container = el.querySelector('.ala-tier-container');
      if (container) {
        if (fallbackText) {
          container.replaceWith(document.createTextNode(fallbackText));
        } else {
          container.remove();
        }
      }
      delete el.dataset.tierModified;
      delete el.dataset.tierSource;
    }

    function processScoreElement(
      el: HTMLElement,
      tiers: TierConfig[],
      colorScore: boolean,
      viewerScoreFormat: string | null,
      isPercentage = false,
      isBlockView = false
    ): void {
      if (el.hasAttribute(PROBE_ATTR)) return;
      if (el.dataset.tierModified) {
        // Re-process when the page re-rendered the cell (our badge is gone) or its score attribute changed.
        const attrNow = el.getAttribute('score');
        const changed = attrNow !== null && attrNow !== el.dataset.tierSource;
        if (el.querySelector('.ala-tier-container') && !changed) return;
        delete el.dataset.tierModified;
      }

      const attr = el.getAttribute('score');
      const rawText = (attr !== null ? attr : el.textContent || '').replace('%', '').trim();
      if (!rawText || rawText === '-' || rawText === '0') {
        clearProcessedCell(el, rawText);
        return;
      }

      const num = parseFloat(rawText);
      if (isNaN(num) || num <= 0) {
        clearProcessedCell(el, rawText);
        return;
      }

      const scoreSystem = el.closest('.compare')
        ? getCompareColumnFormat(el, viewerScoreFormat)
        : getScoreSystem(viewerScoreFormat);
      const normalizedRating = normalizeScore(num, scoreSystem, isPercentage);
      if (normalizedRating === null) {
        clearProcessedCell(el, rawText);
        return;
      }

      const tier = getTier(normalizedRating, tiers);
      if (!tier) {
        clearProcessedCell(el, rawText);
        return;
      }
      ctx.log.debug('Applied tier badge:', tier.label, 'to raw score:', rawText, 'normalized:', normalizedRating);

      el.dataset.tierModified = 'true';
      el.dataset.tierSource = attr ?? '';

      const container = document.createElement('div');
      container.className = `ala-tier-container ${isBlockView ? 'ala-tier-container--block' : ''}`;

      const scoreSpan = document.createElement('span');
      scoreSpan.className = 'ala-tier-score-text';
      if (colorScore) {
        scoreSpan.style.color = tier.color;
      }

      const icon = el.querySelector('svg, .icon');
      if (icon) {
        scoreSpan.appendChild(icon.cloneNode(true));
        scoreSpan.appendChild(document.createTextNode(' ' + rawText));
      } else {
        scoreSpan.textContent = isPercentage ? `${rawText}%` : rawText;
      }

      container.appendChild(scoreSpan);
      container.appendChild(createBadge(tier, isBlockView));

      el.textContent = '';
      el.appendChild(container);
    }

    function processTop100Elements(tiers: TierConfig[], colorScore: boolean): void {
      document.querySelectorAll<HTMLElement>('.row.score').forEach((row) => {
        const percentageEl = row.querySelector<HTMLElement>('.percentage');
        if (!percentageEl || percentageEl.classList.contains('popularity')) return;
        if (percentageEl.dataset.tierModified) {
          if (percentageEl.querySelector('.ala-tier-container')) return;
          delete percentageEl.dataset.tierModified;
        }

        const childNodes = Array.from(percentageEl.childNodes);
        const textNode = childNodes.find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim() !== '');
        if (!textNode) return;

        const ratingText = (textNode.textContent || '').trim().replace('%', '');
        const numericRating = parseFloat(ratingText);
        if (isNaN(numericRating) || numericRating <= 0) return;

        const tier = getTier(numericRating, tiers);
        if (!tier) return;

        percentageEl.dataset.tierModified = 'true';
        textNode.remove();

        const ratingWrapper = document.createElement('div');
        ratingWrapper.className = 'ala-tier-container';
        ratingWrapper.style.display = 'inline-flex';
        ratingWrapper.style.alignItems = 'center';
        ratingWrapper.style.gap = '6px';

        const textSpan = document.createElement('span');
        textSpan.className = 'ala-tier-score-text';
        textSpan.textContent = numericRating + '%';
        if (colorScore) {
          textSpan.style.color = tier.color;
        }

        ratingWrapper.appendChild(textSpan);
        ratingWrapper.appendChild(createBadge(tier));

        const popularityEl = percentageEl.querySelector('.sub-row.popularity');
        if (popularityEl) {
          percentageEl.insertBefore(ratingWrapper, popularityEl);
        } else {
          percentageEl.appendChild(ratingWrapper);
        }
      });
    }

    function applyTierLabels(): void {
      const tiers: TierConfig[] = getValidTiers(ctx.get('tierLabels'));
      const colorScore: boolean = !!ctx.get('tierLabelsColorScore');
      const showAverage: boolean = !!ctx.get('tierLabelsAverageScore');
      const viewerScoreFormat: string | null = ctx.session.scoreFormat;

      document
        .querySelectorAll<HTMLElement>('.score:not(.media-card .score):not(.entry-card .score)')
        .forEach((el) => {
          processScoreElement(el, tiers, colorScore, viewerScoreFormat, false, false);
        });

      document.querySelectorAll<HTMLElement>('.entry-card .score').forEach((el) => {
        processScoreElement(el, tiers, colorScore, viewerScoreFormat, false, true);
      });

      if (showAverage) {
        document.querySelectorAll<HTMLElement>('.data-set').forEach((dataSet) => {
          const label = dataSet.querySelector<HTMLElement>('.type');
          const value = dataSet.querySelector<HTMLElement>('.value');
          if (label && value && (label.textContent || '').includes('Weighted Score')) {
            processScoreElement(value, tiers, colorScore, viewerScoreFormat, true, false);
          }
        });
      }

      processTop100Elements(tiers, colorScore);
    }

    function cleanupTierDom(): void {
      document.querySelectorAll<HTMLElement>('.ala-tier-container').forEach((container) => {
        const parent = container.parentElement;
        if (!parent) {
          container.remove();
          return;
        }
        const scoreSpan = container.querySelector<HTMLElement>('.ala-tier-score-text');
        if (scoreSpan) {
          while (scoreSpan.firstChild) {
            parent.insertBefore(scoreSpan.firstChild, container);
          }
        }
        container.remove();
      });
      document.querySelectorAll<HTMLElement>('[data-tier-modified]').forEach((el) => {
        delete el.dataset.tierModified;
        delete el.dataset.tierSource;
      });
      document.querySelectorAll<HTMLElement & { _colFormats?: Record<string, string> }>('.compare').forEach((c) => {
        delete c._colFormats;
      });
    }

    const HINT_KEY = 'standalone_seen';
    let paused = !!ctx.storage.get<boolean>(HINT_KEY, false);
    let disposed = false;
    let cancelScanTimer: (() => void) | null = null;

    const cancelPendingScan = (): void => {
      if (cancelScanTimer) {
        cancelScanTimer();
        cancelScanTimer = null;
      }
    };

    const runScan = (): void => {
      if (!paused && !disposed) applyTierLabels();
    };

    ctx.onCleanup(() => {
      disposed = true;
      cancelPendingScan();
      cleanupTierDom();
      probeCache = null;
    });

    ctx.ready(() => {
      runScan();
      const unsubNav = ctx.onNav(() => {
        document.querySelectorAll<HTMLElement & { _colFormats?: any }>('.compare').forEach((c) => {
          delete c._colFormats;
        });
        runScan();
      });
      const unsubBody = ctx.onBodyMutation(() => {
        if (paused || disposed || cancelScanTimer) return;
        cancelScanTimer = ctx.timeout(() => {
          cancelScanTimer = null;
          runScan();
        }, 100);
      });

      void probeTierLabels().then((found) => {
        if (disposed) return;
        ctx.storage.set(HINT_KEY, found);
        const wasPaused = paused;
        paused = found;
        if (found) {
          cancelPendingScan();
          unsubNav();
          unsubBody();
          cleanupTierDom();
          if (!wasPaused) {
            ctx.log.warn(
              'Built-in Tier Labels paused: the standalone AniList Tier Labels script is installed. Uninstall it to use the built-in version.'
            );
          }
          ctx.setStandalonePaused(true);
        } else {
          ctx.setStandalonePaused(false);
          if (wasPaused) {
            runScan();
          }
        }
      });
    });
  }
});