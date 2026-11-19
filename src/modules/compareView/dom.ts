import type { FeatureContext } from '../../types';
import {
  STATUSES,
  compareEntries,
  cleanHeaderText,
  getEntryData,
  type CompareState,
  type SortCol,
  type SortDir
} from './data';

export function disableNativeScrollers(listContainer?: HTMLElement): void {
  const root = listContainer?.parentElement || listContainer || document;
  root.querySelectorAll<HTMLElement>('.scroller').forEach((el) => {
    try {
      const v = (el as any).__vue__;
      if (v) {
        if (typeof v.check === 'function') {
          window.removeEventListener('scroll', v.check);
          window.removeEventListener('resize', v.check);
          v._scrollContainer?.removeEventListener?.('scroll', v.check);
          v._scrollContainer?.removeEventListener?.('resize', v.check);
        }
        v.execute = () => {};
        v.handler = () => {};
        if (v.$parent) {
          v.$parent.complete = true;
          v.$parent.loading = false;
        }
        v.$destroy?.();
      }
    } catch {}
    el.remove();
  });
}

function updateHeaderHoverColor(): void {
  const testEl = document.createElement('div');
  testEl.style.color = 'rgb(var(--color-blue))';
  document.body.appendChild(testEl);
  const computedColor = getComputedStyle(testEl).color;
  testEl.remove();

  const m = computedColor.match(/\d+/g);
  let isLight = false;
  if (m && m.length >= 3) {
    const r = parseInt(m[0], 10);
    const g = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const luminance = (r * 299 + g * 587 + b * 114) / 1000;
    isLight = luminance > 155;
  }
  const hoverBg = isLight ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.18)';
  document.documentElement.style.setProperty('--ala-header-hover-bg', hoverBg);
}

function renderHeaderContent(
  el: HTMLElement,
  baseText: string,
  isActive: boolean,
  activeDir: SortDir
): void {
  const clean = cleanHeaderText(baseText);
  let wrap = el.querySelector<HTMLElement>('.ala-header-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'ala-header-wrap';
    el.innerHTML = '';
    el.appendChild(wrap);
  }

  let label = wrap.querySelector<HTMLElement>('.ala-header-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'ala-header-label';
    wrap.appendChild(label);
  }
  label.textContent = clean;

  let arrow = wrap.querySelector<HTMLElement>('.ala-sort-arrow');
  if (isActive) {
    if (!arrow) {
      arrow = document.createElement('span');
      arrow.className = 'ala-sort-arrow';
      wrap.appendChild(arrow);
    }
    arrow.textContent = activeDir === 'asc' ? '▲' : '▼';
  } else {
    arrow?.remove();
  }
}

export function updateSortArrows(
  titleEl: HTMLElement | null,
  yourScoreEl: HTMLElement | null,
  otherScoreEl: HTMLElement | null,
  activeCol: SortCol,
  activeDir: SortDir
): void {
  updateHeaderHoverColor();

  const items: [HTMLElement | null, SortCol][] = [
    [titleEl, 'title'],
    [yourScoreEl, 'yourScore'],
    [otherScoreEl, 'otherScore']
  ];

  for (const [el, col] of items) {
    if (!el) continue;
    el.classList.add('ala-sortable-header');
    if (!(el as any)._alaBaseText) {
      (el as any)._alaBaseText = cleanHeaderText(el.textContent || '');
    }
    const baseText = (el as any)._alaBaseText;
    renderHeaderContent(el, baseText, col === activeCol, activeDir);
  }
}

export function applyFilter(state: CompareState, listContainer: HTMLElement, entries: HTMLElement[]): void {
  let visibleCount = 0;
  for (const el of entries) {
    const d = getEntryData(el);
    const show = state.activeStatuses.has(d.yourStatus) && state.activeStatuses.has(d.otherStatus);

    el.classList.toggle('ala-hidden', !show);
    el.style.display = '';

    if (show) visibleCount++;
  }

  let emptyEl = listContainer.querySelector<HTMLElement>('.ala-compare-empty');
  if (visibleCount === 0 && entries.length > 0) {
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className = 'ala-compare-empty';
      emptyEl.textContent = 'No entries match the selected status filters.';
      listContainer.appendChild(emptyEl);
    }
    emptyEl.style.display = '';
  } else if (emptyEl) {
    emptyEl.style.display = 'none';
  }
}

export function applySort(
  state: CompareState,
  listContainer: HTMLElement,
  entries: HTMLElement[],
  col: SortCol,
  dir: SortDir
): void {
  if (entries.length > 0) {
    listContainer.querySelector('.no-results')?.remove();
  }

  entries.sort((a, b) => compareEntries(getEntryData(a), getEntryData(b), col, dir));

  const frag = document.createDocumentFragment();
  for (const el of entries) {
    frag.appendChild(el);
  }

  state.isMutatingDOM = true;
  listContainer.appendChild(frag);

  const emptyEl = listContainer.querySelector('.ala-compare-empty');
  if (emptyEl) listContainer.appendChild(emptyEl);
  state.isMutatingDOM = false;
}

export function updateStatusCounts(state: CompareState, sidebar: HTMLElement, entries: HTMLElement[]): void {
  const counts: Record<string, number> = {
    Completed: 0,
    Planning: 0,
    Current: 0,
    Paused: 0,
    Dropped: 0
  };
  for (const el of entries) {
    const d = getEntryData(el);
    const counted = new Set([d.yourStatus, d.otherStatus]);
    for (const s of counted) {
      if (s in counts) counts[s]++;
    }
  }

  sidebar.querySelectorAll<HTMLElement>('.ala-compare-count').forEach((span) => {
    const status = span.dataset.status;
    if (status && status in counts) {
      span.textContent = String(counts[status]);
    }
  });

  const badge = sidebar.querySelector<HTMLElement>('.ala-compare-active-badge');
  if (badge) {
    badge.textContent = `${state.activeStatuses.size}/${STATUSES.length}`;
  }
}

export function setLoadIndicator(state: CompareState, sidebar: HTMLElement, text: string | null): void {
  if (state.indicatorTimer) {
    clearTimeout(state.indicatorTimer);
    state.indicatorTimer = null;
  }
  let indicator = sidebar.querySelector<HTMLElement>('#ala-compare-load-indicator');
  if (!text) {
    indicator?.remove();
    return;
  }
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'ala-compare-load-indicator';
    indicator.className = 'ala-compare-load-indicator';
    indicator.innerHTML = `
      <span class="ala-compare-spinner"></span>
      <span class="ala-compare-load-text"></span>
    `;
    const content = sidebar.querySelector('.ala-compare-content') || sidebar.querySelector('.ala-compare-card');
    content?.appendChild(indicator);
  }
  indicator.style.display = 'flex';
  const textEl = indicator.querySelector<HTMLElement>('.ala-compare-load-text');
  if (textEl) textEl.textContent = text;
}

function getActiveCompareContainer(fallback?: HTMLElement): HTMLElement | null {
  return document.getElementById('ala-compare-table') || fallback || document.querySelector('.ala-compare-main .compare') || null;
}

function triggerFilterUpdate(state: CompareState, sidebar: HTMLElement, fallback?: HTMLElement): void {
  const badge = sidebar.querySelector<HTMLElement>('.ala-compare-active-badge');
  if (badge) badge.textContent = `${state.activeStatuses.size}/${STATUSES.length}`;
  const target = getActiveCompareContainer(fallback);
  if (!target) return;
  const currentEntries = Array.from(target.querySelectorAll<HTMLElement>('.entry:not(.header)'));
  applyFilter(state, target, currentEntries);
}

export function triggerSort(state: CompareState, col: SortCol, fallback?: HTMLElement): void {
  if (state.activeSortCol === col) {
    state.activeSortDir = state.activeSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.activeSortCol = col;
    state.activeSortDir = col === 'title' ? 'asc' : 'desc';
  }
  const target = getActiveCompareContainer(fallback);
  if (!target) return;
  const currentHeader = target.querySelector<HTMLElement>('.entry.header');
  if (currentHeader) {
    const titleH = currentHeader.querySelector<HTMLElement>('.title');
    const scores = currentHeader.querySelectorAll<HTMLElement>('.score');
    updateSortArrows(titleH, scores[0] || null, scores[1] || null, state.activeSortCol, state.activeSortDir);
  }
  const currentEntries = Array.from(target.querySelectorAll<HTMLElement>('.entry:not(.header)'));
  applySort(state, target, currentEntries, state.activeSortCol, state.activeSortDir);
}

export function cleanupCompareView(state: CompareState): void {
  if (state.prefetchRelease) {
    state.prefetchRelease();
    state.prefetchRelease = null;
  }
  if (state.indicatorTimer) {
    clearTimeout(state.indicatorTimer);
    state.indicatorTimer = null;
  }
  if (state.loadAbortState) {
    state.loadAbortState.abort = true;
    state.loadAbortState = null;
  }
  state.isLoadingAll = false;
  state.isCompareLoaded = false;
  state.loadFailed = false;
  state.isMutatingDOM = false;
  if (state.resizeCleanup) {
    state.resizeCleanup();
    state.resizeCleanup = null;
  }

  document.getElementById('ala-compare-table')?.remove();

  const wrap = document.getElementById('ala-compare-wrap');
  if (wrap) {
    const main = wrap.querySelector('.ala-compare-main');
    const compareRoot = main?.querySelector<HTMLElement>('.compare:not(#ala-compare-table)') || main?.firstElementChild;
    if (compareRoot && wrap.parentElement) {
      if ((compareRoot as HTMLElement).style) {
        (compareRoot as HTMLElement).style.display = '';
      }
      wrap.parentElement.insertBefore(compareRoot, wrap);
    }
    wrap.remove();
  } else {
    const compareRoot = document.querySelector<HTMLElement>('.compare:not(#ala-compare-table)');
    if (compareRoot) {
      delete compareRoot.dataset.alaCompareInit;
      compareRoot.style.display = '';
    }
  }

  document.querySelectorAll('.ala-compare-page-container').forEach((el) => {
    el.classList.remove('ala-compare-page-container');
  });

  document.querySelectorAll('.compare .entry.ala-hidden').forEach((el) => {
    el.classList.remove('ala-hidden');
  });

  const header = document.querySelector<HTMLElement>('.compare:not(#ala-compare-table) .entry.header, .entry.header');
  if (header) {
    delete (header as any)._alaHeaderBound;
    delete header.dataset.alaCompareInit;
    header.querySelectorAll('.ala-sortable-header').forEach((el) => {
      el.classList.remove('ala-sortable-header');
      const baseText = (el as any)._alaBaseText;
      if (baseText) el.textContent = cleanHeaderText(baseText);
      delete (el as any)._alaBaseText;
    });
    header.querySelectorAll('.status').forEach((el) => {
      const label = el.querySelector('.ala-header-label');
      if (label) el.textContent = label.textContent || '';
    });
  }

  state.lastProcessedCount = -1;
}

function renderSidebarCard(
  ctx: FeatureContext,
  state: CompareState,
  sidebar: HTMLElement,
  compareRoot: HTMLElement
): void {
  if (sidebar.querySelector('.ala-compare-card')) return;
  const isMobileScreen = window.innerWidth <= 850;
  sidebar.innerHTML = `
    <details class="ala-compare-card" ${isMobileScreen ? '' : 'open'}>
      <summary class="ala-compare-card-title">
        <span>Status Filter</span>
        <span class="ala-compare-active-badge">${state.activeStatuses.size}/${STATUSES.length}</span>
        <span class="ala-compare-arrow-icon">▼</span>
      </summary>
      <div class="ala-compare-content">
        <div class="ala-compare-status-list">
          ${STATUSES.map(
            (s) => `
            <label class="ala-compare-status-item">
              <input type="checkbox" class="ala-compare-cb" data-status="${s}" ${state.activeStatuses.has(s) ? 'checked' : ''}>
              <span class="ala-compare-cb-label">${s}</span>
              <span class="ala-compare-count" data-status="${s}">0</span>
            </label>`
          ).join('')}
        </div>
        <div class="ala-compare-actions">
          <button type="button" class="ala-compare-btn-link" id="ala-compare-all">Select all</button>
          <span class="ala-compare-dot">·</span>
          <button type="button" class="ala-compare-btn-link" id="ala-compare-none">Clear all</button>
        </div>
      </div>
    </details>
  `;

  const details = sidebar.querySelector<HTMLDetailsElement>('.ala-compare-card');
  sidebar.querySelector('.ala-compare-card-title')?.addEventListener('click', (e) => {
    if (window.innerWidth > 850) {
      e.preventDefault();
      if (details) details.open = true;
    }
  });

  state.resizeCleanup?.();
  let isDesktop = window.innerWidth > 850;
  const syncDetailsOpen = () => {
    if (!details) return;
    const nowDesktop = window.innerWidth > 850;
    if (nowDesktop !== isDesktop) {
      details.open = nowDesktop;
      isDesktop = nowDesktop;
    }
  };
  state.resizeCleanup = ctx.listen(window, 'resize', syncDetailsOpen);

  sidebar.querySelectorAll<HTMLInputElement>('.ala-compare-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const st = cb.dataset.status!;
      if (cb.checked) state.activeStatuses.add(st);
      else state.activeStatuses.delete(st);
      triggerFilterUpdate(state, sidebar, compareRoot);
    });
  });

  sidebar.querySelector('#ala-compare-all')?.addEventListener('click', () => {
    for (const s of STATUSES) state.activeStatuses.add(s);
    sidebar.querySelectorAll<HTMLInputElement>('.ala-compare-cb').forEach((cb) => (cb.checked = true));
    triggerFilterUpdate(state, sidebar, compareRoot);
  });

  sidebar.querySelector('#ala-compare-none')?.addEventListener('click', () => {
    state.activeStatuses.clear();
    sidebar.querySelectorAll<HTMLInputElement>('.ala-compare-cb').forEach((cb) => (cb.checked = false));
    triggerFilterUpdate(state, sidebar, compareRoot);
  });
}

function findCompareHeaders(header: HTMLElement | null) {
  const headerCells = header ? (Array.from(header.children) as HTMLElement[]) : [];
  if (headerCells.length < 3) {
    return { titleHeader: null, yourScoreHeader: null, otherScoreHeader: null };
  }
  const titleHeader =
    header!.querySelector<HTMLElement>('.title') ||
    headerCells.find((el) => /title/i.test(el.textContent || '')) ||
    headerCells[0];
  const yourScoreHeader =
    headerCells.find((el) => /your score/i.test(el.textContent || '')) ||
    header!.querySelector<HTMLElement>('.score:first-of-type') ||
    headerCells[1];
  const otherScoreHeader =
    headerCells.find((el) => el !== yourScoreHeader && /score/i.test(el.textContent || '')) ||
    header!.querySelectorAll<HTMLElement>('.score')[1] ||
    headerCells[2];
  return { titleHeader, yourScoreHeader, otherScoreHeader };
}

export function setupCompareView(
  ctx: FeatureContext,
  state: CompareState,
  compareRoot: HTMLElement,
  header: HTMLElement | null,
  entries: HTMLElement[],
  onReadyToLoad: (compareRoot: HTMLElement, sidebar: HTMLElement) => void
): void {
  if (header) {
    header.querySelectorAll<HTMLElement>('.status').forEach((statusEl) => {
      if (!statusEl.querySelector('.ala-header-label')) {
        const text = statusEl.textContent?.trim() || '';
        statusEl.innerHTML = `<span class="ala-header-label">${text}</span>`;
      }
    });
  }

  const { titleHeader, yourScoreHeader, otherScoreHeader } = findCompareHeaders(header);

  const container = compareRoot.closest<HTMLElement>('.content.container') || compareRoot.parentElement;
  if (container) {
    container.classList.add('ala-compare-page-container');
  }

  let wrap = document.getElementById('ala-compare-wrap');
  let sidebar = document.getElementById('ala-compare-sidebar');
  if (!wrap || !wrap.contains(compareRoot)) {
    wrap?.remove();
    wrap = document.createElement('div');
    wrap.id = 'ala-compare-wrap';
    wrap.className = 'ala-compare-wrap';

    sidebar = document.createElement('aside');
    sidebar.id = 'ala-compare-sidebar';
    sidebar.className = 'ala-compare-sidebar';

    const main = document.createElement('div');
    main.className = 'ala-compare-main';

    compareRoot.parentElement?.insertBefore(wrap, compareRoot);
    wrap.appendChild(sidebar);
    wrap.appendChild(main);
    main.appendChild(compareRoot);
  }

  if (sidebar) {
    renderSidebarCard(ctx, state, sidebar, compareRoot);
    if (entries.length > 0) {
      updateStatusCounts(state, sidebar, entries);
    }
  }

  if (header && titleHeader && yourScoreHeader && otherScoreHeader && !(header as any)._alaHeaderBound) {
    (header as any)._alaHeaderBound = true;
    titleHeader.addEventListener('click', () => triggerSort(state, 'title', compareRoot));
    yourScoreHeader.addEventListener('click', () => triggerSort(state, 'yourScore', compareRoot));
    otherScoreHeader.addEventListener('click', () => triggerSort(state, 'otherScore', compareRoot));
  }

  if (header && titleHeader) {
    header.dataset.alaCompareInit = 'true';
    updateSortArrows(titleHeader, yourScoreHeader, otherScoreHeader, state.activeSortCol, state.activeSortDir);
  }
  compareRoot.dataset.alaCompareInit = 'true';

  entries.forEach((el) => {
    el.querySelectorAll<HTMLElement>('.score').forEach((scoreEl) => {
      const text = scoreEl.textContent?.trim();
      if (!text || text === '') {
        scoreEl.textContent = '0';
      }
    });
  });

  disableNativeScrollers(compareRoot);

  if (entries.length > 0) {
    applyFilter(state, compareRoot, entries);
    applySort(state, compareRoot, entries, state.activeSortCol, state.activeSortDir);
  }

  if (!state.isLoadingAll && !state.isCompareLoaded && !state.loadFailed && sidebar) {
    onReadyToLoad(compareRoot, sidebar);
  }
}
