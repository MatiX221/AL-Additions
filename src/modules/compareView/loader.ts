import type { FeatureContext } from '../../types';
import type { MediaListEntryItem } from '../../api/anilist';
import { esc } from '../../utils/helpers';
import {
  compareEntries,
  getEntryData,
  isComparePage,
  normalizeStatus,
  type CompareState,
  type EntryData
} from './data';
import {
  applyFilter,
  disableNativeScrollers,
  setLoadIndicator,
  triggerSort,
  updateSortArrows,
  updateStatusCounts
} from './dom';

function getCompareVue(): any {
  const scrollerEl = document.querySelector('.scroller');
  if (scrollerEl && (scrollerEl as any).__vue__?.$parent) {
    return (scrollerEl as any).__vue__.$parent;
  }
  const compareEl = document.querySelector('.compare');
  if (compareEl && (compareEl as any).__vue__) {
    return (compareEl as any).__vue__;
  }
  return null;
}

export function createCompareRpcBlocker(state: CompareState) {
  return (q?: string, vars?: any): boolean =>
    !state.loadFailed &&
    isComparePage() &&
    (/\bcompareWithAuthList\b/i.test(q || '') || Boolean(vars?.compareWithAuthList));
}

function parseCompareRoute(pathname = location.pathname): { userName: string; type: 'ANIME' | 'MANGA' } | null {
  const m = pathname.match(/^\/user\/([^/]+)\/(animelist|mangalist)\/compare(?:\/|$)/i);
  if (!m) return null;
  let userName = m[1];
  try {
    userName = decodeURIComponent(userName);
  } catch {}
  const isManga = m[2].toLowerCase().startsWith('manga');
  return {
    userName,
    type: isManga ? 'MANGA' : 'ANIME'
  };
}

async function resolveCompareUsers(ctx: FeatureContext<true>): Promise<{
  viewerId?: number;
  viewerName?: string;
  otherId?: number;
  otherName?: string;
  type: 'ANIME' | 'MANGA';
}> {
  const route = parseCompareRoute();
  const type: 'ANIME' | 'MANGA' =
    route?.type || (location.pathname.toLowerCase().includes('mangalist') ? 'MANGA' : 'ANIME');
  const bridge = ctx.hooks.getCacheBridge();
  const userMap = bridge?.getUserMap();
  const idMap = bridge?.getIdMap();

  let otherName: string | undefined = route?.userName;
  let otherId: number | undefined;

  if (!otherName) {
    const queryUser = new URLSearchParams(location.search).get('user');
    if (queryUser) otherName = queryUser;
  }

  const vue = getCompareVue();
  if (vue) {
    if (!otherName) otherName = vue.user?.name || vue.userName || undefined;
    if (!otherId) otherId = Number(vue.user?.id || vue.userId) || undefined;
  }

  if (otherName && !otherId && userMap) {
    otherId = userMap.get(otherName.toLowerCase());
  }

  if (otherName && otherId) {
    userMap?.set(otherName.toLowerCase(), otherId);
    idMap?.set(otherId, otherName);
  }

  const snap = ctx.session.peek({ reconcile: true });
  let viewerId = snap.userId || undefined;
  let viewerName = snap.username || undefined;

  if (!viewerId || !viewerName) {
    const viewer = await ctx.api.viewer();
    if (viewer) {
      viewerId = viewer.id;
      viewerName = viewer.name;
    }
  }

  if (!viewerId && viewerName && userMap) {
    viewerId = userMap.get(viewerName.toLowerCase());
  }

  return { viewerId, viewerName, otherId, otherName, type };
}

function buildCompareRow(
  otherEntry: MediaListEntryItem,
  myEntry: MediaListEntryItem,
  type: 'ANIME' | 'MANGA',
  safeOtherName: string,
  scopeAttr: string | undefined
): HTMLElement {
  const mediaId = otherEntry.mediaId;
  const title =
    otherEntry.media?.title?.userPreferred ||
    otherEntry.media?.title?.romaji ||
    otherEntry.media?.title?.english ||
    myEntry.media?.title?.userPreferred ||
    'Unknown';

  const yourScore = myEntry.score || 0;
  const otherScore = otherEntry.score || 0;
  const yourStatus = normalizeStatus(myEntry.status);
  const otherStatus = normalizeStatus(otherEntry.status);

  const row = document.createElement('div');
  row.className = 'entry';
  if (scopeAttr) row.setAttribute(scopeAttr, '');
  const attrStr = scopeAttr ? ` ${scopeAttr}=""` : '';
  row.innerHTML = `
    <div class="title"${attrStr}>
      <a href="/${type.toLowerCase()}/${mediaId}/" class=""${attrStr}></a>
    </div>
    <div class="score" label="Score" score="${yourScore}"${attrStr}><span>${yourScore > 0 ? yourScore : '0'}</span></div>
    <div class="score" label="${safeOtherName}'s Score" score="${otherScore}"${attrStr}><span>${otherScore > 0 ? otherScore : '0'}</span></div>
    <div class="status" label="Your Status"${attrStr}><span>${yourStatus}</span></div>
    <div class="status" label="${safeOtherName}'s Status"${attrStr}><span>${otherStatus}</span></div>
  `;

  const link = row.querySelector<HTMLAnchorElement>('.title a');
  if (link) link.textContent = title;

  const data: EntryData = { el: row, title, yourScore, otherScore, yourStatus, otherStatus };
  (row as any)._alaCompareData = data;
  return row;
}

function mountCompareTable(
  state: CompareState,
  compareRoot: HTMLElement,
  type: 'ANIME' | 'MANGA',
  safeOtherName: string,
  scopeAttr: string | undefined,
  matchedNodes: HTMLElement[]
): HTMLElement | null {
  const main = compareRoot.parentElement || document.querySelector('.ala-compare-main');
  if (!main) return null;

  let customTable = main.querySelector<HTMLElement>('#ala-compare-table');
  if (!customTable) {
    customTable = document.createElement('div');
    customTable.id = 'ala-compare-table';
    customTable.className = 'compare';
    if (scopeAttr) customTable.setAttribute(scopeAttr, '');
    main.appendChild(customTable);
  }

  let customHeader = customTable.querySelector<HTMLElement>('.entry.header');
  if (!customHeader) {
    customHeader = document.createElement('div');
    customHeader.className = 'entry header';
    if (scopeAttr) customHeader.setAttribute(scopeAttr, '');
    const attrStr = scopeAttr ? ` ${scopeAttr}=""` : '';
    customHeader.innerHTML = `
      <div class="title ala-sortable-header"${attrStr}>
        <div class="ala-header-wrap"><span class="ala-header-label">Title</span></div>
      </div>
      <div class="score ala-sortable-header"${attrStr}>
        <div class="ala-header-wrap"><span class="ala-header-label">Your Score</span></div>
      </div>
      <div class="score ala-sortable-header"${attrStr}>
        <div class="ala-header-wrap"><span class="ala-header-label">${safeOtherName}'s Score</span></div>
      </div>
      <div class="status"${attrStr}>
        <span class="ala-header-label">Your Status</span>
      </div>
      <div class="status"${attrStr}>
        <span class="ala-header-label">${safeOtherName}'s Status</span>
      </div>
    `;
    customTable.appendChild(customHeader);

    const titleH = customHeader.querySelector<HTMLElement>('.title');
    const scores = customHeader.querySelectorAll<HTMLElement>('.score');
    titleH?.addEventListener('click', () => triggerSort(state, 'title', compareRoot));
    scores[0]?.addEventListener('click', () => triggerSort(state, 'yourScore', compareRoot));
    scores[1]?.addEventListener('click', () => triggerSort(state, 'otherScore', compareRoot));
  }

  const titleH = customHeader.querySelector<HTMLElement>('.title');
  const scores = customHeader.querySelectorAll<HTMLElement>('.score');
  updateSortArrows(titleH, scores[0] || null, scores[1] || null, state.activeSortCol, state.activeSortDir);

  matchedNodes.sort((a, b) => compareEntries(getEntryData(a), getEntryData(b), state.activeSortCol, state.activeSortDir));

  state.isMutatingDOM = true;
  customTable.querySelectorAll('.entry:not(.header)').forEach((el) => el.remove());

  const frag = document.createDocumentFragment();
  for (const el of matchedNodes) frag.appendChild(el);
  customTable.appendChild(frag);

  if (matchedNodes.length === 0) {
    let empty = customTable.querySelector<HTMLElement>('.no-results');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'no-results';
      empty.textContent = `You don't have any ${type.toLowerCase()} in common ｡ﾟヽ(ﾟ´Д｀)ﾉﾟ｡`;
      customTable.appendChild(empty);
    }
    customHeader.style.display = 'none';
  } else {
    customTable.querySelector('.no-results')?.remove();
    customHeader.style.display = '';
  }

  const emptyEl = customTable.querySelector('.ala-compare-empty');
  if (emptyEl) customTable.appendChild(emptyEl);
  state.isMutatingDOM = false;

  return customTable;
}

export async function loadAllEntriesViaMediaList(
  ctx: FeatureContext<true>,
  state: CompareState,
  compareRoot: HTMLElement,
  sidebar: HTMLElement
): Promise<void> {
  if (state.isLoadingAll || state.isCompareLoaded || state.loadFailed) return;
  state.isLoadingAll = true;
  const abortState = { abort: false };
  state.loadAbortState = abortState;
  state.prefetchRelease?.();
  state.prefetchRelease = ctx.hooks.setPrefetchPaused(true);

  state.indicatorTimer = setTimeout(() => {
    if (!abortState.abort && isComparePage()) {
      setLoadIndicator(state, sidebar, 'Loading full compare list...');
    }
  }, 250);

  try {
    const { viewerId, viewerName, otherId, otherName, type } = await resolveCompareUsers(ctx);
    if (abortState.abort || !isComparePage()) return;

    const viewerTarget = viewerId || viewerName;
    const otherTarget = otherId || otherName;

    if (!viewerTarget || !otherTarget) {
      ctx.log.debug('Missing viewer or other user for getMediaList, keeping fallback');
      state.loadFailed = true;
      return;
    }

    const [myListRes, otherListRes] = await Promise.all([
      ctx.api.getMediaList(viewerTarget, type, {
        userId: viewerId,
        userName: viewerId ? undefined : viewerName
      }),
      ctx.api.getMediaList(otherTarget, type, {
        userId: otherId,
        userName: otherId ? undefined : otherName
      })
    ]);

    if (abortState.abort || !isComparePage()) return;

    const myMap = new Map<number, MediaListEntryItem>();
    for (const entry of myListRes.allEntries) {
      myMap.set(entry.mediaId, entry);
    }

    const displayOtherName = otherListRes.user?.name || otherName || 'User';
    const safeOtherName = esc(displayOtherName);
    const scopeAttr = Array.from(compareRoot.attributes)
      .map((a) => a.name)
      .find((n) => /^data-v-[a-f0-9]+$/i.test(n));

    const seenMediaIds = new Set<number>();
    const matchedNodes: HTMLElement[] = [];
    for (const otherEntry of otherListRes.allEntries) {
      const mediaId = otherEntry.mediaId;
      if (seenMediaIds.has(mediaId)) continue;
      const myEntry = myMap.get(mediaId);
      if (!myEntry) continue;
      seenMediaIds.add(mediaId);
      matchedNodes.push(buildCompareRow(otherEntry, myEntry, type, safeOtherName, scopeAttr));
    }

    ctx.log.debug('Matched entries via MediaListCollection:', matchedNodes.length);

    const customTable = mountCompareTable(state, compareRoot, type, safeOtherName, scopeAttr, matchedNodes);
    if (!customTable) return;

    compareRoot.style.display = 'none';
    disableNativeScrollers(compareRoot);

    state.lastProcessedCount = matchedNodes.length;
    state.isCompareLoaded = true;

    updateStatusCounts(state, sidebar, matchedNodes);
    applyFilter(state, customTable, matchedNodes);
  } catch (err) {
    state.loadFailed = true;
    ctx.log.error('CompareView getMediaList error:', err);
  } finally {
    state.isLoadingAll = false;
    state.loadAbortState = null;
    if (state.prefetchRelease) {
      state.prefetchRelease();
      state.prefetchRelease = null;
    }
    setLoadIndicator(state, sidebar, null);
  }
}
