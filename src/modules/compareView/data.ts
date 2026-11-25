export interface EntryData {
  el: HTMLElement;
  title: string;
  yourScore: number;
  otherScore: number;
  yourStatus: string;
  otherStatus: string;
}

export type SortCol = 'title' | 'yourScore' | 'otherScore';
export type SortDir = 'asc' | 'desc';

export const STATUSES = ['Completed', 'Planning', 'Current', 'Paused', 'Dropped'] as const;

import type { CleanupFn } from '../../types';

export interface CompareState {
  activeSortCol: SortCol;
  activeSortDir: SortDir;
  activeStatuses: Set<string>;
  lastProcessedCount: number;
  currentRoute: string;
  isLoadingAll: boolean;
  isCompareLoaded: boolean;
  loadFailed: boolean;
  isMutatingDOM: boolean;
  disposed: boolean;
  loadAbortState: { abort: boolean } | null;
  resizeCleanup: (() => void) | null;
  indicatorTimer: CleanupFn | null;
  prefetchRelease: (() => void) | null;
}

export function createCompareState(): CompareState {
  return {
    activeSortCol: 'otherScore',
    activeSortDir: 'desc',
    activeStatuses: new Set<string>(STATUSES),
    lastProcessedCount: -1,
    currentRoute: '',
    isLoadingAll: false,
    isCompareLoaded: false,
    loadFailed: false,
    isMutatingDOM: false,
    disposed: false,
    loadAbortState: null,
    resizeCleanup: null,
    indicatorTimer: null,
    prefetchRelease: null
  };
}

export function resetCompareFilters(state: CompareState): void {
  state.activeSortCol = 'otherScore';
  state.activeSortDir = 'desc';
  for (const s of STATUSES) state.activeStatuses.add(s);
}

export const isComparePage = (): boolean => /\/(animelist|mangalist)\/compare/i.test(location.pathname);

export function normalizeStatus(raw: string): string {
  const s = (raw || '').trim().toLowerCase();
  if (s.includes('plan')) return 'Planning';
  if (s.includes('complete')) return 'Completed';
  if (s.includes('current') || s.includes('watch') || s.includes('read') || s.includes('repeat')) return 'Current';
  if (s.includes('pause') || s.includes('hold')) return 'Paused';
  if (s.includes('drop')) return 'Dropped';
  return raw ? raw.trim() : 'Planning';
}

export function getEntryMediaId(el: HTMLElement): number | null {
  const link = el.querySelector<HTMLAnchorElement>('.title a, a.title');
  if (!link) return null;
  const href = link.getAttribute('href') || link.pathname || '';
  const m = href.match(/\/(?:anime|manga)\/(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

const readScore = (el?: HTMLElement): number => {
  const attr = el?.getAttribute('score');
  const parsed = attr ? parseFloat(attr) : parseFloat(el?.textContent?.replace(/[^\d.]/g, '') || '0');
  return Number.isFinite(parsed) ? parsed : 0;
};

export function getEntryData(el: HTMLElement): EntryData {
  const cached = (el as any)._alaCompareData as EntryData | undefined;
  if (cached) return cached;

  const titleLink = el.querySelector<HTMLElement>('.title a, .title');
  const title = (titleLink?.textContent || '').trim();

  const scores = el.querySelectorAll<HTMLElement>('.score');
  const yourScoreEl = el.querySelector<HTMLElement>('.score[label="Score"]') || scores[0];
  const otherScoreEl = Array.from(scores).find((s) => s !== yourScoreEl) || scores[1];

  const statuses = el.querySelectorAll<HTMLElement>('.status');
  const yourStatusEl = el.querySelector<HTMLElement>('.status[label="Your Status"]') || statuses[0];
  const otherStatusEl = Array.from(statuses).find((s) => s !== yourStatusEl) || statuses[1];

  const data: EntryData = {
    el,
    title,
    yourScore: readScore(yourScoreEl),
    otherScore: readScore(otherScoreEl),
    yourStatus: normalizeStatus(yourStatusEl?.textContent || ''),
    otherStatus: normalizeStatus(otherStatusEl?.textContent || '')
  };
  (el as any)._alaCompareData = data;
  return data;
}

export function compareEntries(a: EntryData, b: EntryData, col: SortCol, dir: SortDir): number {
  if (col === 'title') {
    const cmp = a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
    return dir === 'asc' ? cmp : -cmp;
  }

  const aVal = col === 'yourScore' ? a.yourScore : a.otherScore;
  const bVal = col === 'yourScore' ? b.yourScore : b.otherScore;

  if (aVal !== bVal) {
    return dir === 'asc' ? aVal - bVal : bVal - aVal;
  }

  return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
}

export function cleanHeaderText(raw: string): string {
  return raw.replace(/[▲▼]/g, '').trim();
}
