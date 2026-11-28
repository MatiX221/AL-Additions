import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/modules/sync';
import {
  convertScore,
  fuzzyToMalDate,
  buildPayload,
  reconcile,
  fallbackPatch,
  describePatch
} from '../src/modules/sync/reconcile';
import { dedupeTargets, buildTitleIndex, localMatch, runPool, resolveTargets } from '../src/modules/sync/targets';
import {
  syncStore,
  setSyncGet,
  setSyncApi,
  stores,
  syncStatus,
  acquireLock,
  releaseLock,
  addPendingDelete,
  removePendingDelete,
  getPendingDeletes,
  clearPendingDeletes
} from '../src/modules/sync/state';
import {
  alFetchAll,
  alFetchIncremental,
  syncType,
  runSync,
  startManualSync,
  fullResync,
  confirmDecimalScores,
  setSyncConfirm,
  currentListType,
  maybeAutoSync,
  LIST_PATH_RE
} from '../src/modules/sync/engine';
import { openQuickOverrideModal, openOverridesModal } from '../src/modules/sync/overridesModal';
import { extractDialogMedia } from '../src/modules/sync/deletionInterceptor';
import { Settings } from '../src/settings/settings';
import { runMigrations, bootModuleForTest, disposeFeature } from '../src/core/registry';
import { CoreHooks } from '../src/core/bus';
import { clearAccountSecrets } from '../src/core/accounts';
import { anilistApiClient } from '../src/api/anilist';
import { isMalConnected, malLimiter, breaker, hooks, logLines } from '../src/api/mal';
import { OVERRIDES_SETTING_KEY, MANUAL_OVERRIDES_ENABLED_KEY } from '../src/api/malOverrides';
import * as menu from '../src/core/menu';
import { mountPanel, renderRateLimitWarning } from '../src/modules/sync/panel';
import { createModal, openConfirmModal } from '../src/core/modal';
import { store } from '../src/utils/helpers';
import { SETTING_PREFIX, type JsonEditorContext } from '../src/types';
import type { AniListSyncEntry, SyncTarget, SyncCounters } from '../src/modules/sync/types';

const SYNC_STORAGE_PREFIX = 'ala_mod_sync_';

describe('Sync Engine: Score Conversion', () => {
  it('converts scores using "round" mode by default', () => {
    setSyncGet(Settings.get);
    expect(convertScore(0)).toBe(0);
    expect(convertScore(null)).toBe(0);
    expect(convertScore(74)).toBe(7);
    expect(convertScore(75)).toBe(8);
    expect(convertScore(95)).toBe(10);
    expect(convertScore(100)).toBe(10);
    setSyncGet(null);
  });

  it('converts scores using "ceil" mode', () => {
    setSyncGet(() => 'ceil' as any);
    expect(convertScore(71)).toBe(8);
    expect(convertScore(10)).toBe(1);
    expect(convertScore(91)).toBe(10);
    setSyncGet(null);
  });

  it('converts scores using "floor" mode', () => {
    setSyncGet(() => 'floor' as any);
    expect(convertScore(79)).toBe(7);
    expect(convertScore(85)).toBe(8);
    expect(convertScore(99)).toBe(9);
    setSyncGet(null);
  });
});

describe('Sync Engine: Date Formatting', () => {
  it('converts complete fuzzy dates to YYYY-MM-DD strings', () => {
    expect(fuzzyToMalDate({ year: 2024, month: 4, day: 8 })).toBe('2024-04-08');
    expect(fuzzyToMalDate({ year: 2026, month: 10, day: 24 })).toBe('2026-10-24');
  });

  it('returns null for incomplete or missing fuzzy dates', () => {
    expect(fuzzyToMalDate(null)).toBeNull();
    expect(fuzzyToMalDate({ year: 2024, month: 5 })).toBeNull();
    expect(fuzzyToMalDate({ year: 2024, day: 10 })).toBeNull();
  });
});

describe('Sync Engine: Payload Construction & Status Mapping', () => {
  const baseEntry: AniListSyncEntry = {
    mediaId: 100,
    idMal: 200,
    title: 'Frieren: Beyond Journey\'s End',
    status: 'CURRENT',
    score: 90,
    progress: 14,
    repeat: 0,
    queryTitles: ['Frieren'],
    titles: ['frieren'],
    startYear: 2023,
    updatedAt: 1700000000
  };

  it('builds valid payload for anime currently watching', () => {
    const payload = buildPayload('ANIME', baseEntry);
    expect(payload).toEqual({
      status: 'watching',
      score: 9,
      is_rewatching: 'false',
      num_watched_episodes: 14
    });
  });

  it('builds valid payload for manga with volume progress', () => {
    const mangaEntry: AniListSyncEntry = {
      ...baseEntry,
      status: 'PLANNING',
      progress: 5,
      progressVolumes: 2
    };

    const payload = buildPayload('MANGA', mangaEntry);
    expect(payload).toEqual({
      status: 'plan_to_read',
      score: 9,
      is_rereading: 'false',
      num_chapters_read: 5,
      num_volumes_read: 2
    });
  });

  it('flags repeating status as rewatching/rereading', () => {
    const repeatingEntry: AniListSyncEntry = {
      ...baseEntry,
      status: 'REPEATING',
      repeat: 2
    };

    const animePayload = buildPayload('ANIME', repeatingEntry);
    expect(animePayload?.is_rewatching).toBe('true');
    expect(animePayload?.num_times_rewatched).toBe(2);

    const mangaPayload = buildPayload('MANGA', repeatingEntry);
    expect(mangaPayload?.is_rereading).toBe('true');
    expect(mangaPayload?.num_times_reread).toBe(2);
  });
});

describe('Sync Engine: Reconciliation (reconcile)', () => {
  const animeEntry: AniListSyncEntry = {
    mediaId: 101,
    idMal: 201,
    title: 'Steins;Gate',
    status: 'CURRENT',
    score: 100,
    progress: 12,
    repeat: 0,
    queryTitles: ['Steins;Gate'],
    titles: ['steins gate'],
    startYear: 2011,
    updatedAt: 1700000000
  };

  it('returns empty patch when AniList and MAL are already in sync', () => {
    const malData = {
      status: 'watching',
      score: 10,
      num_episodes_watched: 12,
      is_rewatching: false
    };

    const patch = reconcile('ANIME', animeEntry, malData);
    expect(patch).toEqual({});
  });

  it('generates minimal patch for changed progress only', () => {
    const malData = {
      status: 'watching',
      score: 10,
      num_episodes_watched: 11,
      is_rewatching: false
    };

    const patch = reconcile('ANIME', animeEntry, malData);
    expect(patch).toEqual({
      num_watched_episodes: 12
    });
  });

  it('fills total episodes when entry is completed and total is known', () => {
    const completedEntry: AniListSyncEntry = {
      ...animeEntry,
      status: 'COMPLETED',
      progress: 0
    };

    const malData = {
      status: 'watching',
      score: 10,
      num_episodes_watched: 12,
      __total: 24
    };

    const patch = reconcile('ANIME', completedEntry, malData);
    expect(patch?.status).toBe('completed');
    expect(patch?.num_watched_episodes).toBe(24);
  });

  it('describes patch contents in human-readable text', () => {
    const patch = {
      status: 'completed',
      score: 9,
      num_watched_episodes: 24
    };

    const description = describePatch('ANIME', patch);
    expect(description).toContain('status: Completed');
    expect(description).toContain('score: 9/10');
    expect(description).toContain('episodes: 24');
  });
});

describe('Sync Engine: Fallback Recovery (fallbackPatch)', () => {
  it('strips start_date and finish_date on first fallback attempt', () => {
    const patch = {
      status: 'completed',
      start_date: '2024-01-01',
      finish_date: '2024-03-30',
      num_watched_episodes: 12
    };

    const tried = new Set<string>();
    const alt = fallbackPatch('ANIME', patch, null, tried);

    expect(alt).not.toBeNull();
    expect(alt?.start_date).toBeUndefined();
    expect(alt?.finish_date).toBeUndefined();
    expect(alt?.status).toBe('completed');
    expect(tried.has('dates')).toBe(true);
  });

  it('caps episode count to total episodes on second fallback attempt', () => {
    const patch = {
      status: 'completed',
      num_watched_episodes: 15
    };

    const mal = { __total: 12 };
    const tried = new Set<string>(['dates']);
    const alt = fallbackPatch('ANIME', patch, mal, tried);

    expect(alt).not.toBeNull();
    expect(alt?.num_watched_episodes).toBe(12);
    expect(tried.has('cap')).toBe(true);
  });
});

describe('Sync Engine: Target Resolution & Deduplication', () => {
  it('builds title index and resolves strict title matches', () => {
    const malList = {
      5001: { __malTitle: 'Bocchi the Rock!' },
      5002: { __malTitle: 'K-On!' }
    };

    const idx = buildTitleIndex(malList);
    const entry: AniListSyncEntry = {
      mediaId: 1,
      idMal: 0,
      title: 'Bocchi the Rock!',
      status: 'CURRENT',
      score: 90,
      progress: 4,
      repeat: 0,
      queryTitles: ['Bocchi the Rock!'],
      titles: ['bocchi the rock'],
      startYear: 2022,
      updatedAt: 1000
    };

    const matchedId = localMatch(entry, idx);
    expect(matchedId).toBe(5001);
  });

  it('resolves conflicting targets by preferring explicit matches', () => {
    const counters: SyncCounters = {
      pushed: 0,
      deleted: 0,
      unchanged: 0,
      settled: 0,
      skipped: 0,
      unmatched: 0,
      conflicts: 0,
      transient: 0,
      permanent: 0
    };

    const target1: SyncTarget = {
      entry: { mediaId: 10, idMal: 999, title: 'Show A', status: 'CURRENT', score: 0, progress: 1, repeat: 0, queryTitles: [], titles: [], startYear: 0, updatedAt: 100 },
      malId: 999,
      explicit: true
    };

    const target2: SyncTarget = {
      entry: { mediaId: 20, idMal: 0, title: 'Show B', status: 'CURRENT', score: 0, progress: 1, repeat: 0, queryTitles: [], titles: [], startYear: 0, updatedAt: 200 },
      malId: 999,
      explicit: false
    };

    const deduped = dedupeTargets('ANIME', [target2, target1], counters);
    expect(deduped.length).toBe(1);
    expect(deduped[0].entry.mediaId).toBe(10);
    expect(counters.conflicts).toBe(1);
  });
});

describe('Sync Engine: Pending Deletions Queue', () => {
  beforeEach(() => {
    clearPendingDeletes();
  });

  it('queues, retrieves, and removes pending deletions', () => {
    expect(getPendingDeletes()).toEqual([]);

    addPendingDelete({
      mediaId: 42,
      malId: 1042,
      type: 'ANIME',
      title: 'Deleted Anime',
      deletedAt: Date.now()
    });

    const pending = getPendingDeletes();
    expect(pending.length).toBe(1);
    expect(pending[0].mediaId).toBe(42);

    removePendingDelete(42, 'ANIME');
    expect(getPendingDeletes()).toEqual([]);
  });
});

describe('Sync Module: Scoped Storage, Schema < 3 Migration, Reset & Lock Unwind', () => {
  it('matches SYNC_STORAGE_PREFIX with ala_mod_sync_ and migrates schema < 2 and < 3 cleanly with idempotent second run', async () => {
    expect(SYNC_STORAGE_PREFIX).toBe('ala_mod_sync_');

    store.set('sync_schema', 1);
    store.set('mal_mirror_ANIME', { stale: true });
    store.set('last_sync_ANIME', 1000);
    store.set('last_compare_MANGA', 3000);
    store.set('sync_account', 'tester');
    store.set('sync_retry_at', 4000);
    store.set('sync_onboarded', true);
    store.set('sync_lock_heartbeat', { tab: 'old', at: 1 });
    store.set('sync_idmap_ANIME', JSON.stringify({ 1: { m: 10, t: Date.now() } }));
    store.set('sync_settled_MANGA', JSON.stringify({ 2: [1, 'dead', Date.now()] }));
    store.set(
      'sync_pending_deletes',
      JSON.stringify([{ mediaId: 7, malId: 70, type: 'ANIME', title: 'Test', deletedAt: 5000 }])
    );

    runMigrations();

    expect(store.get('sync_schema', null)).toBeNull();
    expect(store.get('mal_mirror_ANIME', null)).toBeNull();
    expect(store.get('sync_lock_heartbeat', null)).toBeNull();
    expect(store.get('last_sync_ANIME', null)).toBeNull();
    expect(store.get('sync_idmap_ANIME', null)).toBeNull();
    expect(store.get('sync_pending_deletes', null)).toBeNull();

    await bootModuleForTest('sync');

    expect(syncStore.get('schema', 0)).toBe(3);
    expect(syncStore.get('last_sync_ANIME', 0)).toBe(1000);
    expect(syncStore.get('last_run_ANIME', 0)).toBe(1000);
    expect(syncStore.get('last_compare_MANGA', 0)).toBe(3000);
    expect(syncStore.get('sync_account', null)).toBe('tester');
    expect(syncStore.get('sync_retry_at', 0)).toBe(4000);
    expect(syncStore.get('sync_onboarded', false)).toBe(true);
    expect(stores.ANIME.ids.data['1']?.m).toBe(10);
    expect(stores.MANGA.settled.data['2']?.[1]).toBe('dead');
    expect(getPendingDeletes()).toHaveLength(1);

    disposeFeature('sync');
    store.set(`${SYNC_STORAGE_PREFIX}last_sync_ANIME`, 9999);
    store.set('last_sync_ANIME', 1111);
    runMigrations();
    expect(store.get(`${SYNC_STORAGE_PREFIX}last_sync_ANIME`, 0)).toBe(9999);
  });

  it('wipes MAL credentials cleanly via clearAccountSecrets("mal") and updates isMalConnected()', () => {
    store.set('mal_token', 'tok');
    store.set('mal_refresh_token', 'ref');
    store.set('mal_expires_at', 999999);
    store.set('mal_code_verifier', 'ver');
    expect(isMalConnected()).toBe(true);

    clearAccountSecrets('mal');

    expect(isMalConnected()).toBe(false);
    expect(store.get('mal_token', null)).toBeNull();
    expect(store.get('mal_refresh_token', null)).toBeNull();
    expect(store.get('mal_expires_at', null)).toBeNull();
    expect(store.get('mal_code_verifier', null)).toBeNull();
  });

  it('clears all scoped data, caches, and credentials via Reset all data menu command and releases lock after unload', async () => {
    const regSpy = vi.spyOn(menu, 'registerMenuCommand');
    try {
      Settings.set('syncEnabled', true);
      store.set('mal_token', 'mal_tok');

      await bootModuleForTest('sync');
      syncStore.set('last_sync_ANIME', 12345);
      stores.ANIME.ids.data['10'] = { m: 20, t: Date.now() };

      const resetCall = regSpy.mock.calls.find(([label]) => String(label).includes('Reset all data'));
      expect(resetCall).toBeDefined();
      (resetCall![1] as () => void)();

      expect(syncStore.get('last_sync_ANIME', null)).toBeNull();
      expect(store.get('mal_token', null)).toBeNull();
      expect(Object.keys(stores.ANIME.ids.data)).toHaveLength(0);

      vi.useFakeTimers();
      try {
        const lockPromise = acquireLock();
        await vi.advanceTimersByTimeAsync(260);
        expect(await lockPromise).toBe(true);
        expect(store.get(`${SYNC_STORAGE_PREFIX}lock_heartbeat`, null)).not.toBeNull();

        disposeFeature('sync');
        releaseLock();
        expect(store.get(`${SYNC_STORAGE_PREFIX}lock_heartbeat`, null)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    } finally {
      disposeFeature('sync');
      regSpy.mockRestore();
    }
  });

  it('re-renders the sync panel via ctx.accounts.watch("mal") on connect and disconnect transitions', async () => {
    history.replaceState({}, '', '/user/MatiX/animelist');
    (window as any).__NUXT__ = { state: { auth: { user: { id: 1, name: 'MatiX' } } } };
    document.body.innerHTML = '<div class="sidebar"><div title="Random List Entry"></div></div>';
    Settings.set('syncEnabled', true);
    store.del('mal_token');

    try {
      await bootModuleForTest('sync');
      mountPanel();

      const panelEl = document.getElementById('ala-sync-panel');
      expect(panelEl).not.toBeNull();
      const disconnectedHtml = panelEl!.innerHTML;
      expect(disconnectedHtml).not.toContain('almal-meta-row');

      store.set('mal_token', 'tok_live');
      expect(panelEl!.innerHTML).toContain('almal-meta-row');
      expect(panelEl!.innerHTML).not.toBe(disconnectedHtml);

      store.del('mal_token');
      expect(panelEl!.innerHTML).toBe(disconnectedHtml);
    } finally {
      disposeFeature('sync');
      delete (window as any).__NUXT__;
      document.body.innerHTML = '';
      history.replaceState({}, '', '/');
      store.del('mal_token');
    }
  });
});

function createEditorContext(overrides: Partial<JsonEditorContext> = {}): {
  ec: JsonEditorContext;
  styleDisposers: Array<ReturnType<typeof vi.fn>>;
  modals: Array<ReturnType<typeof createModal>>;
} {
  const styleDisposers: Array<ReturnType<typeof vi.fn>> = [];
  const modals: Array<ReturnType<typeof createModal>> = [];
  const ac = new AbortController();
  const ec: JsonEditorContext = {
    value: {},
    onApply: vi.fn(),
    signal: ac.signal,
    getId: (name = 'ed') => `ala-test-${name}`,
    addStyle: vi.fn(() => {
      const dispose = vi.fn();
      styleDisposers.push(dispose);
      return dispose;
    }) as any,
    listen: vi.fn(() => () => {}),
    timeout: vi.fn((fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    }),
    observe: vi.fn(() => () => {}),
    modal: (opts) => {
      const handle = createModal(opts);
      modals.push(handle);
      return handle;
    },
    confirm: vi.fn().mockResolvedValue(true),
    alert: vi.fn().mockResolvedValue(undefined),
    toast: {
      show: vi.fn(),
      success: vi.fn(),
      error: vi.fn()
    },
    onCleanup: vi.fn(),
    api: {
      query: vi.fn().mockResolvedValue({}),
      viewer: vi.fn().mockResolvedValue({ id: 1, name: 'Tester', scoreFormat: 'POINT_100' }),
      hasAuth: () => true
    } as any,
    log: {
      label: 'Test',
      title: 'Test',
      canDebug: false,
      enabled: () => false,
      debug: vi.fn() as any,
      warn: vi.fn(),
      error: vi.fn()
    },
    ...overrides
  };
  return { ec, styleDisposers, modals };
}

describe('Sync Batch 7 Bug Fixes (BUG-51..BUG-58)', () => {
  beforeEach(() => {
    store.del(SETTING_PREFIX + OVERRIDES_SETTING_KEY);
    store.del(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY);
    store.del('mal_token');
    store.del('mal_refresh_token');
    store.del('mal_expires_at');
    store.del('ala_mal_api_resume_at');
    clearPendingDeletes();
    malLimiter.until = 0;
    malLimiter.setRate(60);
    malLimiter.tokens = malLimiter.burst;
    breaker.reset();
    vi.mocked(globalThis.GM_xmlhttpRequest).mockReset();
  });

  afterEach(() => {
    disposeFeature('sync');
    disposeFeature('manualOverrides');
    setSyncApi(null);
    setSyncGet(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    history.replaceState({}, '', '/');
    delete (window as any).__NUXT__;
  });

  it('BUG-51: escapes dynamic HTML/XSS payloads and rejects unsafe cover schemes in overridesModal', async () => {
    const xssTitle = '<img src=x onerror=alert(1)>';
    const xssCover = 'javascript:alert(2)';
    store.set(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY, true);
    store.set(SETTING_PREFIX + OVERRIDES_SETTING_KEY, {
      '555': { malId: 777, type: 'ANIME', title: xssTitle, cover: 'https://img.example.com/ok.jpg', updatedAt: 100 }
    });

    const quickCtx = {
      signal: new AbortController().signal,
      api: {
        query: vi.fn().mockResolvedValue({
          Media: {
            id: 555,
            idMal: 777,
            type: 'ANIME',
            title: { userPreferred: xssTitle },
            coverImage: { medium: xssCover }
          }
        })
      },
      addStyle: vi.fn(() => vi.fn()),
      modal: createModal,
      alert: vi.fn().mockResolvedValue(undefined)
    } as any;

    await openQuickOverrideModal(555, 'ANIME', quickCtx);
    const qoPreview = document.getElementById('ala-qo-preview')!;
    expect(qoPreview.querySelector('img[onerror]')).toBeNull();
    expect(qoPreview.textContent).toContain(xssTitle);
    const qoImg = qoPreview.querySelector('img.ala-ov-preview-cover');
    expect(qoImg?.getAttribute('src')).toBe('https://img.example.com/ok.jpg');
    (document.querySelector('#ala-quick-override .ala-core-close') as HTMLButtonElement).click();

    const { ec, modals } = createEditorContext({
      onApply: undefined as any,
      api: {
        query: vi.fn().mockRejectedValue(new Error('<svg onload=alert(3)>')),
        viewer: vi.fn().mockRejectedValue(new Error('<svg onload=alert(4)>'))
      } as any
    });
    openOverridesModal(ec);
    const listBox = modals[0].backdrop.querySelector('#ala-ov-list')!;
    expect(listBox.querySelector('img[onerror]')).toBeNull();
    expect(listBox.textContent).toContain(xssTitle);

    (modals[0].backdrop.querySelector('[data-tab="audit"]') as HTMLButtonElement).click();
    (modals[0].backdrop.querySelector('#ala-ov-btn-scan-orphans') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const orphansBox = modals[0].backdrop.querySelector('#ala-ov-audit-orphans')!;
    expect(orphansBox.querySelector('svg')).toBeNull();
    expect(orphansBox.textContent).toContain('<svg onload=alert(4)>');
    modals[0].close();
  });

  it('BUG-52: skips MAL scan when alFetchAll fails for a type and isolates ANIME/MANGA #1 orphans', async () => {
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);

    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      if (opts.url.includes('/animelist')) {
        opts.onload({
          status: 200,
          responseHeaders: '',
          responseText: JSON.stringify({ data: [{ node: { id: 1, title: 'Cowboy Bebop' }, list_status: { status: 'completed' } }] })
        });
      } else if (opts.url.includes('/mangalist')) {
        opts.onload({
          status: 200,
          responseHeaders: '',
          responseText: JSON.stringify({ data: [{ node: { id: 1, title: 'Monster' }, list_status: { status: 'reading' } }] })
        });
      }
    });

    const queryMock = vi.fn().mockImplementation(async (_q: string, vars: any) => {
      if (vars.type === 'ANIME') {
        return {
          MediaListCollection: {
            hasNextChunk: false,
            lists: [{ entries: [{ media: { id: 100, idMal: 1, title: { userPreferred: 'Anime 1' } } }] }]
          }
        };
      }
      return { MediaListCollection: { hasNextChunk: false, lists: [] } };
    });

    const { ec, modals } = createEditorContext({
      api: {
        viewer: vi.fn().mockResolvedValue({ id: 1, name: 'Tester' }),
        query: queryMock
      } as any
    });

    openOverridesModal(ec);
    const root = modals[0].backdrop;
    (root.querySelector('[data-tab="audit"]') as HTMLButtonElement).click();
    (root.querySelector('#ala-ov-btn-scan-orphans') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));

    // Anime #1 is known on AniList, Manga #1 is NOT -> only Manga #1 should be an orphan
    const orphanItems = root.querySelectorAll('#ala-ov-audit-orphans .ala-ov-item');
    expect(orphanItems).toHaveLength(1);
    expect(orphanItems[0].textContent).toContain('Monster');
    const keepBtn = orphanItems[0].querySelector('.ala-ov-btn-keep-mal') as HTMLButtonElement;
    expect(keepBtn.dataset.type).toBe('MANGA');

    // Now test both Anime #1 and Manga #1 as orphans; Keep on Anime #1 must NOT remove Manga #1
    queryMock.mockImplementation(async () => ({
      MediaListCollection: { hasNextChunk: false, lists: [] }
    }));
    (root.querySelector('#ala-ov-btn-scan-orphans') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelectorAll('#ala-ov-audit-orphans .ala-ov-item')).toHaveLength(2);
    const animeKeepBtn = root.querySelector('.ala-ov-btn-keep-mal[data-type="ANIME"]') as HTMLButtonElement;
    animeKeepBtn.click();
    const remaining = root.querySelectorAll('#ala-ov-audit-orphans .ala-ov-item');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].textContent).toContain('Monster');

    // Now simulate alFetchAll failure for ANIME: malFetchList('/animelist') must NOT be called and error is shown
    malLimiter.until = 0;
    malLimiter.tokens = malLimiter.burst;
    const gmSpy = vi.mocked(globalThis.GM_xmlhttpRequest);
    gmSpy.mockClear();
    queryMock.mockImplementation(async (_q: string, vars: any) => {
      if (vars.type === 'ANIME') throw new Error('AniList 503');
      return { MediaListCollection: { hasNextChunk: false, lists: [] } };
    });
    (root.querySelector('#ala-ov-btn-scan-orphans') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const calledUrls = gmSpy.mock.calls.map((c: any) => String(c[0].url));
    expect(calledUrls.some((u: string) => u.includes('/animelist'))).toBe(false);
    expect(root.querySelector('#ala-ov-audit-orphans')!.textContent).toContain('AniList 503');
    modals[0].close();
  });

  it('BUG-53: queues deletions only on confirmed DeleteMediaListEntry response, clears candidate on Escape, and verifies absence on incremental sync', async () => {
    Settings.set('syncEnabled', true);
    Settings.set('syncMode', 'exact');
    await bootModuleForTest('sync');

    // Hidden dialog vs visible dialog scoping
    document.body.innerHTML = `
      <div class="el-dialog__wrapper" style="display: none;">
        <div class="el-dialog__body">
          <div class="title">Hidden Show</div>
          <div class="header" data-src="/media/anime/cover/bx999-abc.jpg"></div>
        </div>
      </div>
      <div class="el-dialog__wrapper">
        <div class="el-dialog__body">
          <div class="title">Visible Show</div>
          <div class="header" data-src="/media/anime/cover/bx123-abc.jpg"></div>
          <button class="delete-btn">Delete</button>
        </div>
      </div>
      <div class="el-message-box__wrapper">
        <div class="el-message-box">
          <div class="el-message-box__btns"><button class="el-button--primary">OK</button></div>
        </div>
      </div>
    `;
    expect(extractDialogMedia(document.body)?.mediaId).toBe(123);

    // Click Delete + OK -> must NOT queue before response
    (document.querySelector('.delete-btn') as HTMLElement).click();
    (document.querySelector('.el-message-box .el-button--primary') as HTMLElement).click();
    expect(getPendingDeletes()).toHaveLength(0);

    // Pressing Escape clears activeCandidate; subsequent DeleteMediaListEntry response without visible dialog does not use stale candidate
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelectorAll('.el-dialog__wrapper').forEach((el) => el.remove());
    CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { DeleteMediaListEntry(id: 1) { deleted } }',
      variables: { id: 1 },
      ok: true,
      status: 200,
      data: { DeleteMediaListEntry: { deleted: true } }
    });
    expect(getPendingDeletes()).toHaveLength(0);

    // Failed DeleteMediaListEntry response does NOT queue
    document.body.innerHTML = `
      <div class="el-dialog__wrapper">
        <div class="el-dialog__body">
          <div class="title">Real Show</div>
          <div class="header" data-src="/media/anime/cover/bx456-abc.jpg"></div>
          <button class="delete-btn">Delete</button>
        </div>
      </div>
    `;
    (document.querySelector('.delete-btn') as HTMLElement).click();
    CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { DeleteMediaListEntry(id: 2) { deleted } }',
      variables: { id: 2 },
      ok: false,
      status: 500,
      data: { errors: [{ message: 'Server error' }] }
    });
    expect(getPendingDeletes()).toHaveLength(0);

    // Confirmed response DOES queue
    (document.querySelector('.delete-btn') as HTMLElement).click();
    CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { DeleteMediaListEntry(id: 2) { deleted } }',
      variables: { id: 2 },
      ok: true,
      status: 200,
      data: { DeleteMediaListEntry: { deleted: true } }
    });
    expect(getPendingDeletes()).toHaveLength(1);
    expect(getPendingDeletes()[0].mediaId).toBe(456);

    // Incremental sync (!fullPass): verify absence on AniList before deleting; if still present, cancel deletion
    syncStore.set('last_sync_ANIME', 1000);
    syncStore.set('last_compare_ANIME', Date.now());
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);

    let deleteCalls = 0;
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      if (opts.method === 'DELETE') {
        deleteCalls++;
        opts.onload({ status: 200, responseHeaders: '', responseText: '' });
      } else {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ data: [] }) });
      }
    });

    const mockApi = {
      query: vi.fn().mockImplementation(async (q: string) => {
        if (q.includes('mediaList(')) return { Page: { pageInfo: { hasNextPage: false }, mediaList: [] } };
        if (q.includes('mediaListEntry')) return { Media: { id: 456, mediaListEntry: { id: 99 } } };
        return {};
      })
    } as any;
    setSyncApi(mockApi);

    await syncType('ANIME', 1, false);
    expect(deleteCalls).toBe(0);
    expect(getPendingDeletes()).toHaveLength(0);

    // Transient MAL 500 retains pending delete instead of dropping it
    addPendingDelete({ mediaId: 789, malId: 1789, type: 'ANIME', title: 'Keep On Transient', deletedAt: Date.now() });
    mockApi.query.mockImplementation(async (q: string) => {
      if (q.includes('mediaList(')) return { Page: { pageInfo: { hasNextPage: false }, mediaList: [] } };
      if (q.includes('mediaListEntry')) return { Media: { id: 789, mediaListEntry: null } };
      return {};
    });
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      if (opts.method === 'DELETE') {
        opts.onload({ status: 500, responseHeaders: '', responseText: 'Internal Error' });
      } else {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ data: [] }) });
      }
    });

    vi.useFakeTimers();
    malLimiter.last = Date.now();
    const syncP = syncType('ANIME', 1, false);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await syncP;
    vi.useRealTimers();
    expect(res.ok).toBe(false);
    expect(getPendingDeletes().some((p) => p.mediaId === 789)).toBe(true);
  });

  it('BUG-54: throws on invalid MediaListCollection and skips Exact Match auto-delete when resolveTargets has transient errors', async () => {
    await expect(alFetchAll(1, 'ANIME', null)).rejects.toThrow();
    await expect(
      alFetchAll(1, 'ANIME', { query: vi.fn().mockResolvedValue({}) } as any)
    ).rejects.toThrow();

    Settings.set('syncEnabled', true);
    Settings.set('syncMode', 'exact');
    await bootModuleForTest('sync');
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);

    let malDeleteCalls = 0;
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      if (opts.method === 'DELETE') {
        malDeleteCalls++;
        opts.onload({ status: 200, responseHeaders: '', responseText: '' });
      } else if (opts.url.includes('/animelist')) {
        opts.onload({
          status: 200,
          responseHeaders: '',
          responseText: JSON.stringify({
            data: [{ node: { id: 500, title: 'Orphan Candidate' }, list_status: { status: 'completed' } }]
          })
        });
      } else {
        // searchMalId fails with 403 HTML / transient error -> c.transient++
        opts.onload({ status: 403, responseHeaders: '', responseText: '<html>CF</html>' });
      }
    });

    setSyncApi({
      query: vi.fn().mockResolvedValue({
        MediaListCollection: {
          hasNextChunk: false,
          lists: [
            {
              entries: [
                {
                  status: 'CURRENT',
                  score: 0,
                  progress: 1,
                  repeat: 0,
                  updatedAt: 1000,
                  media: { id: 321, idMal: 0, startDate: { year: 2024 }, synonyms: [], title: { userPreferred: 'Unresolved Show' } }
                }
              ]
            }
          ]
        }
      })
    } as any);

    vi.useFakeTimers();
    malLimiter.last = Date.now();
    const syncP = syncType('ANIME', 1, true);
    await vi.advanceTimersByTimeAsync(200_000);
    const res = await syncP;
    vi.useRealTimers();
    expect(res.ok).toBe(false);
    expect(malDeleteCalls).toBe(0);
  });

  it('BUG-55: handles mid-acquireLock disposal, hot-reload runSync race, startManualSync re-entry, and Reset without resurrecting {}', async () => {
    Settings.set('syncEnabled', true);
    await bootModuleForTest('sync');

    // 1. Mid-acquireLock disposal returns false without leaking heartbeat
    vi.useFakeTimers();
    const lockP = acquireLock();
    disposeFeature('sync');
    await vi.advanceTimersByTimeAsync(260);
    expect(await lockP).toBe(false);
    expect(store.get(`${SYNC_STORAGE_PREFIX}lock_heartbeat`, null)).toBeNull();
    vi.useRealTimers();

    // 2. Reset all data clears stores without scheduling debounced save {}
    const regSpy = vi.spyOn(menu, 'registerMenuCommand');
    await bootModuleForTest('sync');
    stores.ANIME.ids.data['10'] = { m: 20, t: Date.now() };
    stores.ANIME.ids.save();
    const resetCall = regSpy.mock.calls.find(([label]) => String(label).includes('Reset all data'));
    expect(resetCall).toBeDefined();
    vi.useFakeTimers();
    (resetCall![1] as () => void)();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.get(`${SYNC_STORAGE_PREFIX}idmap_ANIME`, null)).toBeNull();
    expect(store.get(`${SYNC_STORAGE_PREFIX}settled_ANIME`, null)).toBeNull();
    vi.useRealTimers();
    regSpy.mockRestore();

    // 3. Hot-reload during in-flight runSync: old finally does not clobber new run
    history.replaceState({}, '', '/user/Tester/animelist');
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);
    let resolveViewer!: (v: any) => void;
    const oldViewerPromise = new Promise((r) => {
      resolveViewer = r;
    });
    const slowApi = {
      hasAuth: () => true,
      viewer: vi.fn().mockReturnValueOnce(oldViewerPromise).mockResolvedValue(null),
      clearViewer: vi.fn()
    } as any;
    setSyncApi(slowApi);

    const oldRun = runSync(['ANIME']);
    await new Promise((r) => setTimeout(r, 10));
    disposeFeature('sync');
    await bootModuleForTest('sync');
    // Simulate new sync starting
    let resolveNewViewer!: (v: any) => void;
    const newViewerPromise = new Promise((r) => {
      resolveNewViewer = r;
    });
    setSyncApi({ hasAuth: () => true, viewer: vi.fn().mockReturnValue(newViewerPromise), clearViewer: vi.fn() } as any);
    const newRun = runSync(['ANIME']);
    await new Promise((r) => setTimeout(r, 300));
    // Now resolve old run's viewer so old finally runs while newRun is active
    resolveViewer(null);
    await oldRun;
    // New run must still be syncing
    expect((await import('../src/modules/sync/state')).syncStatus.syncing).toBe(true);
    resolveNewViewer(null);
    await newRun;

    // 4. Double-clicking startManualSync / fullResync during confirmDecimalScores only prompts once
    const windowConfirmSpy = vi.spyOn(window, 'confirm');
    setSyncApi({
      hasAuth: () => true,
      viewer: () => new Promise((r) => setTimeout(() => r({ id: 1, name: 'T', scoreFormat: 'POINT_10_DECIMAL' }), 20)),
      clearViewer: vi.fn()
    } as any);
    const p1 = startManualSync();
    const p2 = startManualSync();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#ala-sync-decimal-scores-confirm')).toHaveLength(1);
    });
    (document.querySelector('#ala-sync-decimal-scores-confirm .ala-core-confirm-cancel') as HTMLButtonElement).click();
    await Promise.all([p1, p2]);
    expect(windowConfirmSpy).not.toHaveBeenCalled();

    syncStore.del('sync_onboarded');
    const f1 = fullResync();
    const f2 = fullResync();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#ala-sync-decimal-scores-confirm')).toHaveLength(1);
    });
    (document.querySelector('#ala-sync-decimal-scores-confirm .ala-core-confirm-cancel') as HTMLButtonElement).click();
    await Promise.all([f1, f2]);
    expect(windowConfirmSpy).not.toHaveBeenCalled();
    windowConfirmSpy.mockRestore();
  });

  it('BUG-56: disposes modal styles onClose, clears malInput on Audit jump, guards post-await DOM, updates staging after Done, and handles inactive sync', async () => {
    // 1. Style disposal & inactive sync Audit notice
    const { ec, modals } = createEditorContext();
    openOverridesModal(ec);
    const modalStyleId = `${modals[0].id}-style`;
    expect(document.getElementById(modalStyleId)).not.toBeNull();
    expect(modals[0].signal.aborted).toBe(false);

    const root = modals[0].backdrop;
    (root.querySelector('[data-tab="audit"]') as HTMLButtonElement).click();
    expect(root.querySelector('#ala-ov-audit-unmatched')!.textContent).toContain('Enable');
    modals[0].close();
    expect(modals[0].signal.aborted).toBe(true);
    expect(document.getElementById(modalStyleId)).toBeNull();

    // 2. Audit jump clears stale malInput.value
    Settings.set('syncEnabled', true);
    await bootModuleForTest('sync');
    stores.ANIME.ids.data['404'] = { m: 0, t: Date.now() };
    const ctx2 = createEditorContext({
      api: {
        query: vi.fn().mockResolvedValue({ Page: { media: [] }, Media: null }),
        viewer: vi.fn().mockResolvedValue({ id: 1, name: 'T' })
      } as any
    });
    openOverridesModal(ctx2.ec);
    const r2 = ctx2.modals[0].backdrop;
    const malInput = r2.querySelector('#ala-ov-mal-input') as HTMLInputElement;
    malInput.value = '99999';
    (r2.querySelector('[data-tab="audit"]') as HTMLButtonElement).click();
    const setBtn = r2.querySelector('.ala-ov-audit-set') as HTMLButtonElement;
    expect(setBtn).not.toBeNull();
    setBtn.click();
    expect(malInput.value).toBe('');
    ctx2.modals[0].close();

    // 3. Staging fast-save updates ec.onApply after Done, and post-await does not mutate detached DOM
    let resolveMeta!: (v: any) => void;
    const metaPromise = new Promise((r) => {
      resolveMeta = r;
    });
    const onApplySpy = vi.fn();
    const ctx3 = createEditorContext({
      onApply: onApplySpy,
      api: { query: vi.fn().mockReturnValue(metaPromise) } as any
    });
    openOverridesModal(ctx3.ec);
    const r3 = ctx3.modals[0].backdrop;
    (r3.querySelector('#ala-ov-al-input') as HTMLInputElement).value = '888';
    (r3.querySelector('#ala-ov-mal-input') as HTMLInputElement).value = '1888';
    (r3.querySelector('#ala-ov-btn-save') as HTMLButtonElement).click();
    (r3.querySelector('#ala-ov-btn-done') as HTMLButtonElement).click();
    expect(onApplySpy).toHaveBeenCalledTimes(1);
    expect(onApplySpy.mock.calls[0][0]['888'].title).toBe('Media #888');

    resolveMeta({
      Media: { id: 888, type: 'ANIME', title: { userPreferred: 'Enriched Title' }, coverImage: { medium: 'https://img.example.com/888.jpg' } }
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onApplySpy).toHaveBeenCalledTimes(2);
    expect(onApplySpy.mock.calls[1][0]['888'].title).toBe('Enriched Title');
  });

  it('BUG-57: resets selfLookup on viewer() null, logs error on manual save failure, and cancels mountSoon on cleanup', async () => {
    history.replaceState({}, '', '/user/MatiX/animelist');
    document.body.innerHTML = '<div class="sidebar"><div title="Random List Entry"></div></div>';
    Settings.set('syncEnabled', true);
    store.del('mal_token');
    store.del('al_username');
    store.del('al_user_id');
    (window as any).__NUXT__ = { state: { auth: { user: { id: 1 } } } };

    vi.useFakeTimers();
    const viewerSpy = vi
      .spyOn(anilistApiClient, 'viewer')
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => {
        store.set('al_username', 'MatiX');
        return { id: 1, name: 'MatiX', scoreFormat: 'POINT_100' };
      });
    await bootModuleForTest('sync');

    await vi.advanceTimersByTimeAsync(10);
    expect(viewerSpy).toHaveBeenCalledTimes(1);

    // Retry should invoke viewer() again because selfLookup was reset in .finally()
    mountPanel();
    await vi.advanceTimersByTimeAsync(260);
    expect(viewerSpy).toHaveBeenCalledTimes(2);
    expect(document.getElementById('ala-sync-panel')).not.toBeNull();

    // Manual save failure logs at 'error' level
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      opts.onload({ status: 400, responseHeaders: '', responseText: JSON.stringify({ error: 'invalid_grant' }) });
    });
    (document.querySelector('[data-act="manual-toggle"]') as HTMLButtonElement).click();
    (document.getElementById('almal-mal-manual') as HTMLInputElement).value = 'bad_code';
    (document.querySelector('[data-act="mal-manual-save"]') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(logLines[0]).toContain('ERROR');
    expect(logLines[0]).toContain('MAL token exchange failed');

    // Cancel mountSoon on cleanup so it does not mount after dispose
    disposeFeature('sync');
    store.del('al_username');
    await bootModuleForTest('sync');
    mountPanel();
    disposeFeature('sync');
    await vi.advanceTimersByTimeAsync(300);
    expect(document.getElementById('ala-sync-panel')).toBeNull();
    vi.useRealTimers();
  });

  it('BUG-58: fallbackPatch caps over-limit progress before stripping valid start_date and finish_date', () => {
    const patch = {
      status: 'completed',
      start_date: '2024-01-01',
      finish_date: '2024-03-30',
      num_watched_episodes: 15
    };
    const tried = new Set<string>();
    const alt = fallbackPatch('ANIME', patch, { __total: 12 }, tried);

    expect(alt).not.toBeNull();
    expect(alt?.num_watched_episodes).toBe(12);
    expect(alt?.start_date).toBe('2024-01-01');
    expect(alt?.finish_date).toBe('2024-03-30');
    expect(tried.has('cap')).toBe(true);
    expect(tried.has('dates')).toBe(false);
  });

  it('Batch 10 (IMP-01, IMP-03, IMP-04, IMP-09): migrates overridesModal, sync panel, and sync engine to unified modal/route/debounce/signal APIs', async () => {
    // 1. IMP-01 + IMP-09 in openQuickOverrideModal: ModalOptions.style, [data-ala-close], modal.signal, late query guard
    let resolveQuick!: (v: any) => void;
    const quickQuery = vi.fn().mockReturnValue(new Promise((r) => { resolveQuick = r; }));
    const quickAc = new AbortController();
    const openedModals: Array<ReturnType<typeof createModal>> = [];
    const quickCtx = {
      signal: quickAc.signal,
      api: { query: quickQuery },
      modal: (opts: any) => {
        const h = createModal(opts);
        openedModals.push(h);
        return h;
      },
      alert: vi.fn().mockResolvedValue(undefined)
    } as any;

    const modalPromise = openQuickOverrideModal(701, 'ANIME', quickCtx);
    expect(openedModals).toHaveLength(1);
    const qm = openedModals[0];
    expect(document.getElementById(`${qm.id}-style`)).not.toBeNull();
    const cancelBtn = qm.backdrop.querySelector('[data-ala-close]') as HTMLButtonElement;
    expect(cancelBtn).not.toBeNull();
    cancelBtn.click();
    expect(qm.signal.aborted).toBe(true);
    expect(document.getElementById(`${qm.id}-style`)).toBeNull();

    resolveQuick({ Media: { id: 701, idMal: 1701, type: 'ANIME', title: { userPreferred: 'Late' } } });
    await modalPromise;
    expect(qm.backdrop.querySelector('#ala-qo-preview')?.textContent).not.toContain('Late');

    // 2. IMP-01 + IMP-09 in openOverridesModal: modal.timeout timers cleaned on close, ec.signal guard
    vi.useFakeTimers();
    const lookupQuery = vi.fn().mockResolvedValue({ Media: null });
    const { ec, modals } = createEditorContext({
      api: { query: lookupQuery, viewer: vi.fn().mockResolvedValue(null) } as any
    });
    openOverridesModal(ec);
    const alInput = modals[0].backdrop.querySelector('#ala-ov-al-input') as HTMLInputElement;
    alInput.value = '9001';
    alInput.dispatchEvent(new Event('input', { bubbles: true }));
    modals[0].close();
    await vi.advanceTimersByTimeAsync(400);
    expect(lookupQuery).not.toHaveBeenCalled();

    const abortedEcAc = new AbortController();
    abortedEcAc.abort();
    const abortedCtx = createEditorContext({ signal: abortedEcAc.signal });
    openOverridesModal(abortedCtx.ec);
    expect(abortedCtx.modals).toHaveLength(0);
    vi.useRealTimers();

    // 3. IMP-03 + IMP-04 in sync/panel.ts: route exit cancels rc.onBodyMutation and rc.debounce
    vi.useFakeTimers();
    history.replaceState({}, '', '/user/MatiX/animelist');
    (window as any).__NUXT__ = { state: { auth: { user: { id: 1, name: 'MatiX' } } } };
    Settings.set('syncEnabled', true);
    await bootModuleForTest('sync');
    // Navigate away before 250ms debounce fires; then attach anchor and mutate body
    history.replaceState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    document.body.innerHTML = '<div class="sidebar"><div title="Random List Entry"></div></div>';
    await vi.advanceTimersByTimeAsync(500);
    expect(document.getElementById('ala-sync-panel')).toBeNull();
    vi.useRealTimers();

    // 4. IMP-09 in sync/engine.ts: AbortSignal stops startManualSync and runSync cleanly
    const windowConfirmSpy = vi.spyOn(window, 'confirm');
    let resolveViewer!: (v: any) => void;
    setSyncApi({
      hasAuth: () => true,
      viewer: () => new Promise((r) => { resolveViewer = r; }),
      clearViewer: vi.fn()
    } as any);
    const syncAc = new AbortController();
    const manualP = startManualSync(syncAc.signal);
    syncAc.abort();
    resolveViewer({ id: 1, name: 'MatiX', scoreFormat: 'POINT_10_DECIMAL' });
    await manualP;
    expect(document.getElementById('ala-decimal-scores-confirm')).toBeNull();
    expect(windowConfirmSpy).not.toHaveBeenCalled();
    windowConfirmSpy.mockRestore();

    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);
    syncStore.del('sync_account');
    let resolveRunViewer!: (v: any) => void;
    setSyncApi({
      hasAuth: () => true,
      viewer: () => new Promise((r) => { resolveRunViewer = r; }),
      clearViewer: vi.fn()
    } as any);
    const runAc = new AbortController();
    vi.useFakeTimers();
    const runP = runSync(['ANIME'], { signal: runAc.signal });
    await vi.advanceTimersByTimeAsync(260);
    runAc.abort();
    resolveRunViewer({ id: 1, name: 'MatiX', scoreFormat: 'POINT_100' });
    await runP;
    vi.useRealTimers();
    expect(syncStore.get('sync_account', null)).toBeNull();
    expect((await import('../src/modules/sync/state')).syncStatus.syncing).toBe(false);
  });

  it('Batch 11 (IMP-10, IMP-13): uses non-blocking confirm/alert with re-entrant guards & disposal cleanup, and isolates MAL calls from hooks.checkCancel', async () => {
    hooks.checkCancel = undefined;
    const winConfirmSpy = vi.spyOn(window, 'confirm');
    const winAlertSpy = vi.spyOn(window, 'alert');

    // 1. IMP-13: booting sync does not mutate hooks.checkCancel
    history.replaceState({}, '', '/user/MatiX/animelist');
    (window as any).__NUXT__ = { state: { auth: { user: { id: 1, name: 'MatiX' } } } };
    document.body.innerHTML = '<div class="sidebar"><div title="Random List Entry"></div></div>';
    Settings.set('syncEnabled', true);
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);

    await bootModuleForTest('sync');
    expect(hooks.checkCancel).toBeUndefined();

    // 2. IMP-10 in sync/panel.ts: resync uses ctx.confirm, guards re-entrant clicks, and closes on module disposal
    mountPanel();
    const panelEl = document.getElementById('ala-sync-panel')!;
    const resyncBtn = panelEl.querySelector('[data-act="resync"]') as HTMLButtonElement;
    const syncBtn = panelEl.querySelector('[data-act="sync"]') as HTMLButtonElement;
    expect(resyncBtn).not.toBeNull();
    resyncBtn.click();
    resyncBtn.click(); // re-entrant click must be ignored
    syncBtn.click(); // concurrent sync click while confirm open must be ignored

    expect(resyncBtn.disabled).toBe(true);
    expect(syncBtn.disabled).toBe(true);
    const resyncModals = document.querySelectorAll('#ala-sync-full-resync-confirm');
    expect(resyncModals).toHaveLength(1);

    // Cancel re-enables buttons without starting sync
    (resyncModals[0].querySelector('.ala-core-confirm-cancel') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('ala-sync-full-resync-confirm')).toBeNull();
    expect(resyncBtn.disabled).toBe(false);
    expect(syncBtn.disabled).toBe(false);

    // Disposal while resync confirm modal is open auto-closes modal cleanly
    resyncBtn.click();
    expect(document.getElementById('ala-sync-full-resync-confirm')).not.toBeNull();
    disposeFeature('sync');
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('ala-sync-full-resync-confirm')).toBeNull();

    // 3. IMP-08 + IMP-10 in confirmDecimalScores: returns false when unset and aborts cleanly via ctx.confirm signal
    setSyncApi({
      hasAuth: () => true,
      viewer: vi.fn().mockResolvedValue({ id: 1, name: 'MatiX', scoreFormat: 'POINT_10_DECIMAL' }),
      clearViewer: vi.fn()
    } as any);
    await expect(confirmDecimalScores()).resolves.toBe(false);
    expect(document.getElementById('ala-decimal-scores-confirm')).toBeNull();

    await bootModuleForTest('sync');
    setSyncApi({
      hasAuth: () => true,
      viewer: vi.fn().mockResolvedValue({ id: 1, name: 'MatiX', scoreFormat: 'POINT_10_DECIMAL' }),
      clearViewer: vi.fn()
    } as any);
    const decAc = new AbortController();
    const decPromise = confirmDecimalScores(decAc.signal);
    await vi.waitFor(() => {
      expect(document.getElementById('ala-sync-decimal-scores-confirm')).not.toBeNull();
    });
    decAc.abort();
    await expect(decPromise).resolves.toBe(false);
    expect(document.getElementById('ala-sync-decimal-scores-confirm')).toBeNull();
    disposeFeature('sync');

    // 4. IMP-10 in openQuickOverrideModal: uses ctx.alert and guards Save button against re-entry
    let resolveQuickAlert!: () => void;
    const quickAlert = vi.fn().mockImplementation(
      () => new Promise<void>((r) => { resolveQuickAlert = r; })
    );
    const quickCtx = {
      signal: new AbortController().signal,
      api: { query: vi.fn().mockResolvedValue({ Media: { id: 901, idMal: null, type: 'ANIME', title: { userPreferred: 'No MAL' } } }) },
      modal: createModal,
      alert: quickAlert
    } as any;
    await openQuickOverrideModal(901, 'ANIME', quickCtx);
    const qoSave = document.getElementById('ala-qo-btn-save') as HTMLButtonElement;
    qoSave.click();
    qoSave.click();
    expect(quickAlert).toHaveBeenCalledTimes(1);
    expect(qoSave.disabled).toBe(true);
    resolveQuickAlert();
    await new Promise((r) => setTimeout(r, 0));
    expect(qoSave.disabled).toBe(false);
    (document.querySelector('#ala-quick-override .ala-core-close') as HTMLButtonElement).click();

    // 5. IMP-10 & IMP-13 in openOverridesModal: ec.alert / ec.confirm + re-entrant guards + hooks.checkCancel isolation + modal close abort
    hooks.checkCancel = () => {
      throw Object.assign(new Error('Sync cancelled should not affect overridesModal'), { cancelled: true });
    };
    let resolveAlert!: () => void;
    const ecAlert = vi.fn().mockImplementation(
      () => new Promise<void>((r) => { resolveAlert = r; })
    );
    let resolveDelConfirm!: (v: boolean) => void;
    const ecConfirm = vi.fn().mockImplementation(
      () => new Promise<boolean>((r) => { resolveDelConfirm = r; })
    );
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      if (opts.url.includes('/animelist')) {
        opts.onload({
          status: 200,
          responseHeaders: '',
          responseText: JSON.stringify({ data: [{ node: { id: 55, title: 'Orphan 55' }, list_status: { status: 'completed' } }] })
        });
      } else if (opts.url.includes('/mangalist')) {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ data: [] }) });
      } else if (opts.method === 'DELETE') {
        opts.onload({ status: 500, responseHeaders: '', responseText: 'Delete boom' });
      }
    });

    const { ec, modals } = createEditorContext({
      alert: ecAlert,
      confirm: ecConfirm,
      api: {
        viewer: vi.fn().mockResolvedValue({ id: 1, name: 'Tester' }),
        query: vi.fn().mockResolvedValue({ MediaListCollection: { hasNextChunk: false, lists: [] } })
      } as any
    });
    openOverridesModal(ec);
    const root = modals[0].backdrop;

    // Validation alerts on Save / Ignore guard against re-entry
    const ovSave = root.querySelector('#ala-ov-btn-save') as HTMLButtonElement;
    const ovIgnore = root.querySelector('#ala-ov-btn-ignore') as HTMLButtonElement;
    ovSave.click();
    ovSave.click();
    expect(ecAlert).toHaveBeenCalledTimes(1);
    expect(ovSave.disabled).toBe(true);
    resolveAlert();
    await new Promise((r) => setTimeout(r, 0));
    expect(ovSave.disabled).toBe(false);

    ovIgnore.click();
    ovIgnore.click();
    expect(ecAlert).toHaveBeenCalledTimes(2);
    expect(ovIgnore.disabled).toBe(true);
    resolveAlert();
    await new Promise((r) => setTimeout(r, 0));
    expect(ovIgnore.disabled).toBe(false);

    // Scan orphans succeeds despite global hooks.checkCancel throwing
    (root.querySelector('[data-tab="audit"]') as HTMLButtonElement).click();
    (root.querySelector('#ala-ov-btn-scan-orphans') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));

    const delMalBtn = root.querySelector('.ala-ov-btn-del-mal') as HTMLButtonElement;
    expect(delMalBtn).not.toBeNull();
    delMalBtn.click();
    delMalBtn.click();
    expect(ecConfirm).toHaveBeenCalledTimes(1);
    expect(delMalBtn.disabled).toBe(true);

    // Cancel confirm -> no DELETE call, button re-enabled
    resolveDelConfirm(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(delMalBtn.disabled).toBe(false);

    // Confirm delete -> DELETE fails 500 -> calls ec.alert (wait out malCall retries with fake timers)
    vi.useFakeTimers();
    delMalBtn.click();
    resolveDelConfirm(true);
    await vi.advanceTimersByTimeAsync(100_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(ecAlert).toHaveBeenCalledTimes(3));
    resolveAlert();
    await new Promise((r) => setTimeout(r, 0));
    expect(delMalBtn.disabled).toBe(false);

    modals[0].close();
    hooks.checkCancel = undefined;
    expect(winConfirmSpy).not.toHaveBeenCalled();
    expect(winAlertSpy).not.toHaveBeenCalled();
  });
});

describe('Cycle 2 Batch 3 Sync Bug Fixes (BUG-27..BUG-33)', () => {
  beforeEach(() => {
    store.del(SETTING_PREFIX + OVERRIDES_SETTING_KEY);
    store.del(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY);
    store.del('mal_token');
    store.del('mal_refresh_token');
    store.del('mal_expires_at');
    store.del('ala_mal_api_resume_at');
    store.del('al_username');
    store.del('al_user_id');
    clearPendingDeletes();
    syncStatus.syncing = false;
    syncStatus.cancelled = false;
    syncStatus.autoSyncRetryAfter = 0;
    malLimiter.until = 0;
    malLimiter.last = 0;
    malLimiter.setRate(6000);
    malLimiter.tokens = malLimiter.burst;
    breaker.reset();
    vi.mocked(globalThis.GM_xmlhttpRequest).mockReset();
  });

  afterEach(() => {
    disposeFeature('sync');
    disposeFeature('manualOverrides');
    setSyncApi(null);
    setSyncGet(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    history.replaceState({}, '', '/');
    delete (window as any).__NUXT__;
  });

  it('BUG-27: resolveTargets and runPool honor AbortSignal / checkCancel and skip remaining MAL lookups', async () => {
    // 1. runPool stops claiming items once signal aborts
    const poolAc = new AbortController();
    const visited: number[] = [];
    await expect(
      runPool(
        [1, 2, 3, 4, 5],
        async (n) => {
          visited.push(n);
          if (n === 1) poolAc.abort();
        },
        1,
        { signal: poolAc.signal }
      )
    ).rejects.toMatchObject({ cancelled: true });
    expect(visited).toEqual([1]);

    // 2. resolveTargets passes signal/checkCancel to searchMalId and skips queued lookups on abort
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);
    const ac = new AbortController();
    const searchedUrls: string[] = [];
    const pendingRequests: Array<{ abort?: () => void; onload?: (r: any) => void }> = [];

    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      searchedUrls.push(String(opts.url));
      pendingRequests.push(opts);
      if (searchedUrls.length === 2) {
        ac.abort();
      }
      return { abort: () => opts.onabort?.() } as any;
    });

    const entries: AniListSyncEntry[] = Array.from({ length: 6 }, (_, idx) => ({
      mediaId: 1000 + idx,
      idMal: 0,
      title: `Show Title ${idx}`,
      queryTitles: [`Show Title ${idx}`],
      titles: [`show title ${idx}`],
      status: 'CURRENT',
      score: 0,
      progress: 1,
      repeat: 0,
      startYear: 2024,
      updatedAt: 1000 + idx
    }));
    const counters: SyncCounters = {
      pushed: 0,
      deleted: 0,
      unchanged: 0,
      settled: 0,
      skipped: 0,
      unmatched: 0,
      conflicts: 0,
      transient: 0,
      permanent: 0
    };

    await expect(
      resolveTargets('ANIME', entries, {}, counters, { signal: ac.signal })
    ).rejects.toMatchObject({ cancelled: true });
    expect(searchedUrls.length).toBeLessThanOrEqual(3);
  });

  it('BUG-28: forwards AbortSignal to AniList query and viewer calls in engine.ts and overridesModal.ts', async () => {
    Settings.set('syncEnabled', true);
    Settings.set('syncMode', 'exact');
    await bootModuleForTest('sync');
    history.replaceState({}, '', '/user/MatiX/animelist');
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);

    const queryCalls: Array<{ q: string; opts: any }> = [];
    const viewerCalls: Array<any> = [];
    const engineAc = new AbortController();

    const mockApi = {
      hasAuth: () => true,
      clearViewer: vi.fn(),
      viewer: vi.fn().mockImplementation(async (_fresh?: boolean, opts?: any) => {
        viewerCalls.push(opts);
        return { id: 1, name: 'MatiX', scoreFormat: 'POINT_100' };
      }),
      query: vi.fn().mockImplementation(async (q: string, _vars?: any, opts?: any) => {
        queryCalls.push({ q, opts });
        if (q.includes('MediaListCollection')) {
          return { MediaListCollection: { hasNextChunk: false, lists: [] } };
        }
        if (q.includes('mediaList(')) {
          return { Page: { pageInfo: { hasNextPage: false }, mediaList: [] } };
        }
        if (q.includes('mediaListEntry')) {
          return { Media: { id: 77, mediaListEntry: { id: 10 } } };
        }
        return {};
      })
    } as any;
    setSyncApi(mockApi);

    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      if (opts.url.includes('/users/@me')) {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ id: 42 }) });
      } else {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ data: [] }) });
      }
    });

    await alFetchAll(1, 'ANIME', mockApi, engineAc.signal);
    await alFetchIncremental(1, 'ANIME', 100, engineAc.signal);
    await confirmDecimalScores(engineAc.signal);

    addPendingDelete({ mediaId: 77, type: 'ANIME', title: 'Check Signal', deletedAt: Date.now() });
    syncStore.set('last_sync_ANIME', 1000);
    syncStore.set('last_compare_ANIME', Date.now());
    await syncType('ANIME', 1, false, engineAc.signal);

    await runSync(['ANIME'], { signal: engineAc.signal });

    expect(queryCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of queryCalls) {
      expect(call.opts?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(viewerCalls.length).toBeGreaterThanOrEqual(2);
    for (const opts of viewerCalls) {
      expect(opts?.signal).toBe(engineAc.signal);
    }

    // overridesModal.ts: quick modal, doLookup, fetchMissingMeta, scanOrphansBtn, batchFetchUnmatchedMeta
    const ovQueries: Array<{ q: string; opts: any }> = [];
    const ovViewers: Array<any> = [];
    const quickCtx = {
      signal: new AbortController().signal,
      api: {
        query: vi.fn().mockImplementation(async (q: string, _v?: any, opts?: any) => {
          ovQueries.push({ q, opts });
          return { Media: { id: 501, idMal: 1501, type: 'ANIME', title: { userPreferred: 'Quick' } } };
        })
      },
      modal: createModal,
      alert: vi.fn().mockResolvedValue(undefined)
    } as any;
    await openQuickOverrideModal(501, 'ANIME', quickCtx);
    expect(ovQueries[0].opts?.signal).toBeInstanceOf(AbortSignal);
    (document.querySelector('#ala-quick-override .ala-core-close') as HTMLButtonElement).click();

    stores.ANIME.ids.data['601'] = { m: 0, t: Date.now() };
    const { ec, modals } = createEditorContext({
      api: {
        viewer: vi.fn().mockImplementation(async (_f?: boolean, opts?: any) => {
          ovViewers.push(opts);
          return new Promise((_res, rej) => {
            opts?.signal?.addEventListener('abort', () => rej(new DOMException('Request aborted', 'AbortError')));
          });
        }),
        query: vi.fn().mockImplementation(async (q: string, _v?: any, opts?: any) => {
          ovQueries.push({ q, opts });
          return { Page: { media: [] }, Media: null };
        })
      } as any
    });
    openOverridesModal(ec);
    const root = modals[0].backdrop;
    (root.querySelector('#ala-ov-al-input') as HTMLInputElement).value = '602';
    (root.querySelector('#ala-ov-al-input') as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 320));
    (root.querySelector('[data-tab="audit"]') as HTMLButtonElement).click();
    (root.querySelector('#ala-ov-btn-scan-orphans') as HTMLButtonElement).click();
    expect(ovViewers[0]?.signal).toBeInstanceOf(AbortSignal);
    // Closing modal aborts scan cleanly without throwing/logging noise
    modals[0].close();
    await new Promise((r) => setTimeout(r, 10));
    expect(ovViewers[0].signal.aborted).toBe(true);
    expect(ec.log?.warn).not.toHaveBeenCalled();
    expect(ovQueries.length).toBeGreaterThanOrEqual(3);
    for (const call of ovQueries) {
      expect(call.opts?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('BUG-29: protects AniList-Only (malId: 0) and unmatched entries from Exact Match auto-delete and orphan Audit', async () => {
    Settings.set('syncEnabled', true);
    Settings.set('syncMode', 'exact');
    Settings.set(MANUAL_OVERRIDES_ENABLED_KEY, true);
    store.set(SETTING_PREFIX + OVERRIDES_SETTING_KEY, {
      '10': { malId: 0, type: 'ANIME', title: 'Ignored With idMal', updatedAt: 100 },
      '11': { malId: 0, type: 'ANIME', title: 'Ignored With Cached MAL', updatedAt: 100 }
    });
    await bootModuleForTest('sync');
    stores.ANIME.ids.data['11'] = { m: 2011, t: Date.now() };
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);

    const deletedMalIds: number[] = [];
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      if (opts.method === 'DELETE') {
        const m = String(opts.url).match(/\/anime\/(\d+)/);
        if (m) deletedMalIds.push(Number(m[1]));
        opts.onload({ status: 200, responseHeaders: '', responseText: '' });
      } else if (opts.url.includes('/animelist')) {
        opts.onload({
          status: 200,
          responseHeaders: '',
          responseText: JSON.stringify({
            data: [
              { node: { id: 2010, title: 'Ignored With idMal' }, list_status: { status: 'completed' } },
              { node: { id: 2011, title: 'Ignored With Cached MAL' }, list_status: { status: 'completed' } },
              { node: { id: 9999, title: 'True Orphan' }, list_status: { status: 'completed' } }
            ]
          })
        });
      } else if (opts.url.includes('/mangalist')) {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ data: [] }) });
      } else {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ data: [] }) });
      }
    });

    // 1. Exact Match fullPass deletes ONLY 9999 and protects 2010 (idMal) and 2011 (cached)
    setSyncApi({
      query: vi.fn().mockResolvedValue({
        MediaListCollection: {
          hasNextChunk: false,
          lists: [
            {
              entries: [
                { status: 'COMPLETED', score: 0, progress: 12, repeat: 0, updatedAt: 100, media: { id: 10, idMal: 2010, title: { userPreferred: 'Ignored With idMal' }, synonyms: [] } },
                { status: 'COMPLETED', score: 0, progress: 12, repeat: 0, updatedAt: 100, media: { id: 11, idMal: 0, title: { userPreferred: 'Ignored With Cached MAL' }, synonyms: [] } }
              ]
            }
          ]
        }
      })
    } as any);

    await syncType('ANIME', 1, true);
    expect(deletedMalIds).toEqual([9999]);

    // 2. When c.unmatched > 0, Exact Match orphan auto-delete is skipped completely
    deletedMalIds.length = 0;
    stores.ANIME.ids.data['12'] = { m: 0, t: Date.now() };
    setSyncApi({
      query: vi.fn().mockResolvedValue({
        MediaListCollection: {
          hasNextChunk: false,
          lists: [
            {
              entries: [
                { status: 'COMPLETED', score: 0, progress: 12, repeat: 0, updatedAt: 100, media: { id: 12, idMal: 0, title: { userPreferred: 'Unmatched Entry' }, synonyms: [] } }
              ]
            }
          ]
        }
      })
    } as any);
    await syncType('ANIME', 1, true);
    expect(deletedMalIds).toEqual([]);
    expect(logLines.some((line) => line.includes('unmatched') && line.includes('auto-delete was skipped'))).toBe(true);

    // 3. scanOrphansBtn excludes ignored entries' idMal (2010) and cached MAL ID (2011) from orphans
    malLimiter.until = 0;
    malLimiter.last = 0;
    malLimiter.tokens = malLimiter.burst;
    const { ec, modals } = createEditorContext({
      onApply: undefined as any,
      api: {
        viewer: vi.fn().mockResolvedValue({ id: 1, name: 'Tester' }),
        query: vi.fn().mockImplementation(async (_q: string, vars: any) => {
          if (vars.type === 'ANIME') {
            return {
              MediaListCollection: {
                hasNextChunk: false,
                lists: [
                  {
                    entries: [
                      { media: { id: 10, idMal: 2010, title: { userPreferred: 'Ignored With idMal' } } },
                      { media: { id: 11, idMal: 0, title: { userPreferred: 'Ignored With Cached MAL' } } }
                    ]
                  }
                ]
              }
            };
          }
          return { MediaListCollection: { hasNextChunk: false, lists: [] } };
        })
      } as any
    });
    openOverridesModal(ec);
    const root = modals[0].backdrop;
    (root.querySelector('[data-tab="audit"]') as HTMLButtonElement).click();
    (root.querySelector('#ala-ov-btn-scan-orphans') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(root.querySelectorAll('#ala-ov-audit-orphans .ala-ov-item')).toHaveLength(1);
    });
    const orphanItems = root.querySelectorAll('#ala-ov-audit-orphans .ala-ov-item');
    expect(orphanItems[0].textContent).toContain('True Orphan');
    modals[0].close();
  });

  it('BUG-30: deletionInterceptor rejects HTTP 200 GraphQL errors, DeleteMediaListEntry: null, and failed SaveMediaListEntry', async () => {
    Settings.set('syncEnabled', true);
    Settings.set('syncMode', 'exact');
    await bootModuleForTest('sync');

    document.body.innerHTML = `
      <div class="el-dialog__wrapper">
        <div class="el-dialog__body">
          <div class="title">Test Show</div>
          <div class="header" data-src="/media/anime/cover/bx555-abc.jpg"></div>
          <button class="delete-btn">Delete</button>
        </div>
      </div>
    `;

    // 1. HTTP 200 with GraphQL errors must NOT queue
    (document.querySelector('.delete-btn') as HTMLElement).click();
    CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { DeleteMediaListEntry(id: 5) { deleted } }',
      variables: { id: 5 },
      ok: true,
      status: 200,
      errors: [{ message: 'Unauthorized' }],
      data: { DeleteMediaListEntry: { deleted: true } }
    });
    expect(getPendingDeletes()).toHaveLength(0);

    // 2. HTTP 200 with DeleteMediaListEntry: null must NOT queue
    (document.querySelector('.delete-btn') as HTMLElement).click();
    CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { DeleteMediaListEntry(id: 5) { deleted } }',
      variables: { id: 5 },
      ok: true,
      status: 200,
      data: { DeleteMediaListEntry: null }
    });
    expect(getPendingDeletes()).toHaveLength(0);

    // 3. Confirmed DeleteMediaListEntry: { deleted: true } without errors queues pending delete
    (document.querySelector('.delete-btn') as HTMLElement).click();
    CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { DeleteMediaListEntry(id: 5) { deleted } }',
      variables: { id: 5 },
      ok: true,
      status: 200,
      data: { DeleteMediaListEntry: { deleted: true } }
    });
    expect(getPendingDeletes()).toHaveLength(1);

    // 4. Failed SaveMediaListEntry (HTTP 200 with errors or SaveMediaListEntry: null) keeps pending delete
    CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { SaveMediaListEntry(mediaId: 555) { id } }',
      variables: { mediaId: 555 },
      ok: true,
      status: 200,
      errors: [{ message: 'Save failed' }],
      data: { SaveMediaListEntry: null }
    });
    expect(getPendingDeletes()).toHaveLength(1);

    CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { SaveMediaListEntry(mediaId: 555) { id } }',
      variables: { mediaId: 555 },
      ok: false,
      status: 500,
      data: { SaveMediaListEntry: { id: 99 } }
    });
    expect(getPendingDeletes()).toHaveLength(1);

    // 5. Confirmed SaveMediaListEntry removes pending delete
    CoreHooks.emitGqlFetch({
      phase: 'response',
      url: '/graphql',
      query: 'mutation { SaveMediaListEntry(mediaId: 555) { id } }',
      variables: { mediaId: 555 },
      ok: true,
      status: 200,
      data: { SaveMediaListEntry: { id: 99 } }
    });
    expect(getPendingDeletes()).toHaveLength(0);
  });

  it('BUG-31: maybeAutoSync backs off during confirmation/startingSync and runSync aborts sibling syncType on auth/abort failure', async () => {
    Settings.set('syncEnabled', true);
    Settings.set('syncAutoAnime', true);
    Settings.set('syncAutoManga', true);
    history.replaceState({}, '', '/user/MatiX/animelist');
    (window as any).__NUXT__ = { state: { auth: { user: { id: 1, name: 'MatiX' } } } };
    document.body.innerHTML = '<div class="sidebar"><div title="Random List Entry"></div></div>';
    store.set('al_username', 'MatiX');
    store.set('al_user_id', 1);
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);

    // 1. maybeAutoSync skips while startManualSync / confirmDecimalScores is awaiting confirmation
    let resolveViewer!: (v: any) => void;
    const viewerMock = vi.fn().mockImplementation(
      () => new Promise((r) => { resolveViewer = r; })
    );
    setSyncApi({ hasAuth: () => true, viewer: viewerMock, clearViewer: vi.fn() } as any);
    setSyncConfirm((opts) => openConfirmModal(opts));

    try {
      const manualP = startManualSync();
      maybeAutoSync();
      expect(viewerMock).toHaveBeenCalledTimes(1); // auto-sync did not start a second viewer/runSync
      resolveViewer({ id: 1, name: 'MatiX', scoreFormat: 'POINT_10_DECIMAL' });
      await vi.waitFor(() => {
        expect(document.getElementById('ala-decimal-scores-confirm')).not.toBeNull();
      });
      maybeAutoSync();
      expect(viewerMock).toHaveBeenCalledTimes(1); // still backed off while confirm dialog is open
      (document.querySelector('#ala-decimal-scores-confirm .ala-core-confirm-cancel') as HTMLButtonElement).click();
      await manualP;
    } finally {
      setSyncConfirm(null);
    }

    // 2. panel.ts skips maybeAutoSync during pendingConfirm (full-resync-confirm open)
    Settings.set('syncAutoAnime', false);
    Settings.set('syncAutoManga', false);
    vi.useFakeTimers();
    await bootModuleForTest('sync');
    mountPanel();
    const resyncBtn = document.querySelector('[data-act="resync"]') as HTMLButtonElement;
    resyncBtn.click();
    Settings.set('syncAutoAnime', true);
    Settings.set('syncAutoManga', true);
    const viewerSpy = vi.spyOn(anilistApiClient, 'viewer');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(viewerSpy).not.toHaveBeenCalled();
    (document.querySelector('#ala-sync-full-resync-confirm .ala-core-confirm-cancel') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    disposeFeature('sync');

    // 3. runSync aborts sibling syncType immediately when the other fails with auth error
    Settings.set('syncAutoAnime', false);
    Settings.set('syncAutoManga', false);
    await bootModuleForTest('sync');
    let mangaSignal: AbortSignal | undefined;
    let resolveManga!: (v: any) => void;
    setSyncApi({
      hasAuth: () => true,
      clearViewer: vi.fn(),
      viewer: vi.fn().mockResolvedValue({ id: 1, name: 'MatiX', scoreFormat: 'POINT_100' }),
      query: vi.fn().mockImplementation(async (_q: string, vars: any, opts?: any) => {
        if (vars.type === 'ANIME') {
          const authErr: any = new Error('AniList unauthorized');
          authErr.auth = 'AniList';
          throw authErr;
        }
        mangaSignal = opts?.signal;
        return new Promise((res, rej) => {
          resolveManga = res;
          opts?.signal?.addEventListener('abort', () => rej(new DOMException('Request aborted', 'AbortError')));
        });
      })
    } as any);

    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      if (opts.url.includes('/users/@me')) {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ id: 42 }) });
      } else {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ data: [] }) });
      }
    });

    await runSync(['ANIME', 'MANGA'], { full: true });
    expect(mangaSignal?.aborted).toBe(true);
    void resolveManga;
  });

  it('BUG-32: isolates pendingConfirm across hot-reload and aligns LIST_PATH_RE / onRoute (mixed-case yes, /compare no)', async () => {
    Settings.set('syncEnabled', true);
    store.set('al_username', 'MatiX');
    store.set('al_user_id', 1);
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);
    (window as any).__NUXT__ = { state: { auth: { user: { id: 1, name: 'MatiX' } } } };

    // 1. Regex behavior: mixed-case list routes match; /compare subpaths are excluded
    expect(LIST_PATH_RE.test('/user/MatiX/AnimeList')).toBe(true);
    expect(LIST_PATH_RE.test('/user/MatiX/MangaList/')).toBe(true);
    expect(LIST_PATH_RE.test('/user/MatiX/animelist/compare')).toBe(false);
    expect(LIST_PATH_RE.test('/user/MatiX/mangalist/compare/')).toBe(false);

    history.replaceState({}, '', '/user/MatiX/AnimeList/');
    expect(currentListType()).toBe('ANIME');
    history.replaceState({}, '', '/user/MatiX/animelist/compare');
    expect(currentListType()).toBeNull();

    document.body.innerHTML = '<div class="sidebar"><div title="Random List Entry"></div></div>';
    await bootModuleForTest('sync');
    mountPanel();
    expect(document.getElementById('ala-sync-panel')).toBeNull();

    // Navigating to mixed-case own list mounts the panel
    history.replaceState({}, '', '/user/MatiX/AnimeList');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await new Promise((r) => setTimeout(r, 270));
    expect(document.getElementById('ala-sync-panel')).not.toBeNull();

    // 2. Hot-reload while ACTIONS.sync is awaiting confirmation does not let old finally clear new instance's pendingConfirm
    disposeFeature('sync');
    let resolveOldViewer!: (v: any) => void;
    await bootModuleForTest('sync');
    setSyncApi({
      hasAuth: () => true,
      viewer: () => new Promise((r) => { resolveOldViewer = r; }),
      clearViewer: vi.fn()
    } as any);
    mountPanel();
    const oldSyncBtn = document.querySelector('[data-act="sync"]') as HTMLButtonElement;
    oldSyncBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    // Hot-reload before old ACTIONS.sync resolves
    disposeFeature('sync');
    await bootModuleForTest('sync');
    mountPanel();
    const newResyncBtn = document.querySelector('[data-act="resync"]') as HTMLButtonElement;
    const newSyncBtn = document.querySelector('[data-act="sync"]') as HTMLButtonElement;
    newResyncBtn.click();
    expect(newResyncBtn.disabled).toBe(true);
    expect(newSyncBtn.disabled).toBe(true);

    // Resolve old ACTIONS.sync while new instance's confirm is open; old finally must NOT clear pendingConfirm
    resolveOldViewer(null);
    await new Promise((r) => setTimeout(r, 10));
    expect(newResyncBtn.disabled).toBe(true);
    expect(newSyncBtn.disabled).toBe(true);
    // Re-triggering sync must still be blocked by pendingConfirm
    newSyncBtn.disabled = false;
    newSyncBtn.click();
    expect(document.querySelectorAll('#ala-sync-full-resync-confirm')).toHaveLength(1);

    (document.querySelector('#ala-sync-full-resync-confirm .ala-core-confirm-cancel') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(newResyncBtn.disabled).toBe(false);
    expect(newSyncBtn.disabled).toBe(false);
  });

  it('BUG-33: preserves disabled Delete-from-MAL state across orphan re-render and ignores stale overlapping doLookup responses', async () => {
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);

    // 1. Overlapping doLookup responses for the same ID: older slow response must NOT overwrite newer fast response
    let resolveLookup1!: (v: any) => void;
    let resolveLookup2!: (v: any) => void;
    let lookupCount = 0;

    let resolveDelete!: (status: number) => void;
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      if (opts.url.includes('/animelist')) {
        opts.onload({
          status: 200,
          responseHeaders: '',
          responseText: JSON.stringify({
            data: [
              { node: { id: 101, title: 'Orphan One' }, list_status: { status: 'completed' } },
              { node: { id: 102, title: 'Orphan Two' }, list_status: { status: 'completed' } }
            ]
          })
        });
      } else if (opts.url.includes('/mangalist')) {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ data: [] }) });
      } else if (opts.method === 'DELETE') {
        resolveDelete = (status: number) =>
          opts.onload({ status, responseHeaders: '', responseText: '' });
      }
    });

    const { ec, modals } = createEditorContext({
      confirm: vi.fn().mockResolvedValue(true),
      api: {
        viewer: vi.fn().mockResolvedValue({ id: 1, name: 'Tester' }),
        query: vi.fn().mockImplementation(async (q: string) => {
          if (q.includes('MediaListCollection')) {
            return { MediaListCollection: { hasNextChunk: false, lists: [] } };
          }
          lookupCount++;
          if (lookupCount === 1) return new Promise((r) => { resolveLookup1 = r; });
          return new Promise((r) => { resolveLookup2 = r; });
        })
      } as any
    });

    vi.useFakeTimers();
    openOverridesModal(ec);
    const root = modals[0].backdrop;
    const alInput = root.querySelector('#ala-ov-al-input') as HTMLInputElement;

    alInput.value = '777';
    alInput.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(310);

    alInput.value = '';
    alInput.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(310);

    alInput.value = '777';
    alInput.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(310);
    vi.useRealTimers();

    resolveLookup2({ Media: { id: 777, idMal: 1777, type: 'ANIME', title: { userPreferred: 'Fresh Title' } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('#ala-ov-preview')!.textContent).toContain('Fresh Title');

    resolveLookup1({ Media: { id: 777, idMal: 1777, type: 'ANIME', title: { userPreferred: 'Stale Title' } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('#ala-ov-preview')!.textContent).toContain('Fresh Title');
    expect(root.querySelector('#ala-ov-preview')!.textContent).not.toContain('Stale Title');

    // 2. Orphan delete button stays disabled ("Deleting...") across re-renders while DELETE is in flight
    (root.querySelector('[data-tab="audit"]') as HTMLButtonElement).click();
    (root.querySelector('#ala-ov-btn-scan-orphans') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));

    const delBtn1 = root.querySelector('.ala-ov-btn-del-mal[data-mal-id="101"]') as HTMLButtonElement;
    delBtn1.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(delBtn1.disabled).toBe(true);
    expect(delBtn1.textContent).toBe('Deleting...');

    // Trigger re-render by clicking Keep on Orphan 102 while DELETE 101 is still in flight
    (root.querySelector('.ala-ov-btn-keep-mal[data-mal-id="102"]') as HTMLButtonElement).click();
    const rerenderedDelBtn1 = root.querySelector('.ala-ov-btn-del-mal[data-mal-id="101"]') as HTMLButtonElement;
    expect(rerenderedDelBtn1).not.toBeNull();
    expect(rerenderedDelBtn1.disabled).toBe(true);
    expect(rerenderedDelBtn1.textContent).toBe('Deleting...');

    resolveDelete(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(root.querySelector('.ala-ov-btn-del-mal[data-mal-id="101"]')).toBeNull();
    modals[0].close();
  });

  it('Cycle 2 Batch 6 (IMP-08, IMP-14): unifies dialog signals on confirm/alert and mounts/repairs/tears down sync panel via rc.mount', async () => {
    // 1. IMP-08: openQuickOverrideModal & openOverridesModal forward modal signal to alert/confirm and abort on close
    const quickModals: Array<ReturnType<typeof createModal>> = [];
    let quickAlertOpts: any = null;
    const quickCtx = {
      signal: new AbortController().signal,
      api: { query: vi.fn().mockResolvedValue({ Media: { id: 910, idMal: null, type: 'ANIME', title: { userPreferred: 'No MAL' } } }) },
      modal: (opts: any) => {
        const h = createModal(opts);
        quickModals.push(h);
        return h;
      },
      alert: vi.fn().mockImplementation((opts: any) => {
        quickAlertOpts = opts;
        return openConfirmModal({ ...opts, cancelText: 'OK' }).then(() => undefined);
      })
    } as any;

    await openQuickOverrideModal(910, 'ANIME', quickCtx);
    (document.getElementById('ala-qo-btn-save') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(quickAlertOpts?.signal).toBeInstanceOf(AbortSignal));
    expect(quickAlertOpts.signal.aborted).toBe(false);
    quickModals[0].close();
    expect(quickAlertOpts.signal.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 0));

    let ovAlertOpts: any = null;
    let ovConfirmOpts: any = null;
    store.set('mal_token', 'tok_ok');
    store.set('mal_expires_at', Date.now() + 3600_000);
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      if (opts.url.includes('/animelist')) {
        opts.onload({
          status: 200,
          responseHeaders: '',
          responseText: JSON.stringify({ data: [{ node: { id: 77, title: 'Orphan 77' }, list_status: { status: 'completed' } }] })
        });
      } else {
        opts.onload({ status: 200, responseHeaders: '', responseText: JSON.stringify({ data: [] }) });
      }
    });
    const { ec, modals } = createEditorContext({
      alert: vi.fn().mockImplementation((opts: any) => {
        ovAlertOpts = opts;
        return new Promise<void>(() => {});
      }),
      confirm: vi.fn().mockImplementation((opts: any) => {
        ovConfirmOpts = opts;
        return new Promise<boolean>(() => {});
      }),
      api: {
        viewer: vi.fn().mockResolvedValue({ id: 1, name: 'Tester' }),
        query: vi.fn().mockResolvedValue({ MediaListCollection: { hasNextChunk: false, lists: [] } })
      } as any
    });
    openOverridesModal(ec);
    const ovRoot = modals[0].backdrop;
    (ovRoot.querySelector('#ala-ov-btn-save') as HTMLButtonElement).click();
    expect(ovAlertOpts?.signal).toBeInstanceOf(AbortSignal);
    expect(ovAlertOpts.signal.aborted).toBe(false);

    (ovRoot.querySelector('[data-tab="audit"]') as HTMLButtonElement).click();
    (ovRoot.querySelector('#ala-ov-btn-scan-orphans') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(ovRoot.querySelector('.ala-ov-btn-del-mal')).not.toBeNull());
    (ovRoot.querySelector('.ala-ov-btn-del-mal') as HTMLButtonElement).click();
    expect(ovConfirmOpts?.signal).toBeInstanceOf(AbortSignal);
    expect(ovConfirmOpts.signal.aborted).toBe(false);

    modals[0].close();
    expect(ovAlertOpts.signal.aborted).toBe(true);
    expect(ovConfirmOpts.signal.aborted).toBe(true);

    // 2. IMP-14: rc.mount mounting, mutation repair, _limitCancel cleanup on unmount, and route-exit teardown
    vi.useFakeTimers();
    history.replaceState({}, '', '/user/MatiX/animelist');
    (window as any).__NUXT__ = { state: { auth: { user: { id: 1, name: 'MatiX' } } } };
    store.set('al_username', 'MatiX');
    store.set('al_user_id', 1);
    Settings.set('syncEnabled', true);
    document.body.innerHTML = '<div class="sidebar"><div class="anchor-box" title="Random List Entry"></div></div>';

    await bootModuleForTest('sync');

    const sidebar = document.querySelector('.sidebar')!;
    const firstPanel = document.getElementById('ala-sync-panel') as (HTMLElement & { _limitCancel?: (() => void) | null }) | null;
    expect(firstPanel).not.toBeNull();
    expect(sidebar.nextElementSibling).toBe(firstPanel);
    expect(document.getElementById('ala-sync-panel-style')).not.toBeNull();

    // Schedule _limitCancel via renderRateLimitWarning and verify cleanup on mutation-triggered unmount/remount
    malLimiter.until = Date.now() + 5000;
    renderRateLimitWarning(firstPanel);
    expect(typeof firstPanel!._limitCancel).toBe('function');
    const prevCancelSpy = vi.fn(firstPanel!._limitCancel!);
    firstPanel!._limitCancel = prevCancelSpy;

    // Removing panel triggers Core.onBodyMutation -> rc.mount cleans up old element's _limitCancel & remounts
    firstPanel!.remove();
    await vi.advanceTimersByTimeAsync(60);
    expect(prevCancelSpy).toHaveBeenCalledTimes(1);
    expect(firstPanel!._limitCancel).toBeNull();

    const repairedPanel = document.getElementById('ala-sync-panel') as (HTMLElement & { _limitCancel?: (() => void) | null }) | null;
    expect(repairedPanel).not.toBeNull();
    expect(repairedPanel).not.toBe(firstPanel);
    expect(typeof repairedPanel!._limitCancel).toBe('function');
    const repairedCancelSpy = vi.fn(repairedPanel!._limitCancel!);
    repairedPanel!._limitCancel = repairedCancelSpy;

    // Navigating away tears down panel, style, and _limitCancel
    history.replaceState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById('ala-sync-panel')).toBeNull();
    expect(document.getElementById('ala-sync-panel-style')).toBeNull();
    expect(repairedCancelSpy).toHaveBeenCalledTimes(1);
    expect(repairedPanel!._limitCancel).toBeNull();
    vi.useRealTimers();
  });
});