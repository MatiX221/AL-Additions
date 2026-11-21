import { defineModule } from '../../core/registry';
import { log } from '../../api/mal';
import {
  MANUAL_OVERRIDES_ENABLED_KEY,
  OVERRIDES_SETTING_KEY,
  getManualOverrides,
  validateOverrides
} from '../../api/malOverrides';
import { safe } from '../../utils/helpers';
import type { SyncMediaType } from './types';
import { TYPES } from './types';
import {
  stores,
  initSyncStores,
  syncStore,
  setSyncLog,
  setSyncGet,
  setSyncStorage,
  setSyncApi,
  clearCache,
  releaseLock,
  syncStatus
} from './state';
import { initSyncPanel, renderPanel } from './panel';
import { configureOverridesModalStyle, openQuickOverrideModal, openOverridesModal } from './overridesModal';
import { initDeletionInterceptor } from './deletionInterceptor';

declare module '../../types' {
  interface ServiceMap {
    'manualOverrides:quickEdit': (mediaId: number, mediaType?: SyncMediaType) => void | Promise<void>;
  }
  interface EventMap {
    'manualOverrides:changed': number;
  }
}

defineModule({
  id: 'sync',
  key: 'syncEnabled',
  section: 'Sync',
  hosts: ['anilist.co', 'myanimelist.net'],
  layer: 'service',
  requiresReload: false,
  accounts: ['mal'],
  legacy: ['syncEnabled', 'syncOn'],
  title: 'AniList → MyAnimeList Sync',
  help: 'Enable sync and show the list page sync panel',
  debug: {
    label: 'Sync',
    title: 'Sync Debug',
    help: 'Log MAL synchronization steps, queue processing, rate limits, and deletions.'
  },
  options: [
    {
      key: 'syncAutoAnime',
      type: 'toggle',
      def: false,
      legacy: ['syncAutoAnime'],
      title: 'Auto-Sync Anime',
      help: 'Automatically sync your anime list to MyAnimeList in the background.'
    },
    {
      key: 'syncIntervalAnime',
      type: 'number',
      childOf: 'syncAutoAnime',
      def: 6,
      min: 1,
      max: 720,
      legacy: ['syncIntervalAnime', 'syncIntervalHours', 'autoSyncIntervalHours', 'autoSyncInterval'],
      title: 'Auto-Sync Anime Interval',
      help: 'How often to automatically sync your anime list (in hours, minimum 1).'
    },
    {
      key: 'syncAutoManga',
      type: 'toggle',
      def: false,
      legacy: ['syncAutoManga'],
      title: 'Auto-Sync Manga',
      help: 'Automatically sync your manga list to MyAnimeList in the background.'
    },
    {
      key: 'syncIntervalManga',
      type: 'number',
      childOf: 'syncAutoManga',
      def: 6,
      min: 1,
      max: 720,
      legacy: ['syncIntervalManga', 'syncIntervalMangaHours', 'autoSyncIntervalMangaHours', 'syncIntervalHours'],
      title: 'Auto-Sync Manga Interval',
      help: 'How often to automatically sync your manga list (in hours, minimum 1).'
    },
    {
      key: 'syncScoreRounding',
      type: 'select',
      def: 'round',
      options: [
        ['ceil', 'Ceil'],
        ['round', 'Round'],
        ['floor', 'Floor']
      ],
      legacy: ['syncScoreRounding', 'scoreConversionMethod'],
      title: 'Decimal Score Conversion',
      help: 'MyAnimeList only accepts whole-number scores. <b>Ceil</b> always rounds up (7.4 → 8), <b>Round</b> rounds normally (7.4 → 7, 7.5 → 8), and <b>Floor</b> always rounds down (7.9 → 7).'
    },
    {
      key: 'syncMode',
      type: 'select',
      def: 'update',
      options: [
        ['update', 'Update Only'],
        ['exact', 'Exact Match (Mirror)']
      ],
      legacy: ['syncMode'],
      title: 'Sync Mode',
      help: '<b>Update Only</b> (default) only adds and updates entries on MyAnimeList, keeping existing MAL entries intact if deleted on AniList. <b>Exact Match (Mirror)</b> automatically deletes entries from MyAnimeList when removed from AniList.'
    }
  ],
  migrate(m) {
    if ((m.storage.get<number>('schema', 0) || 0) < 3) {
      safe(() => {
        // @migration(from: "pre-0.8.0", kind: "storage", sunset: "keep-long")
        if ((m.legacy.get<number>('sync_schema', 0) || 0) < 2) {
          for (const k of [
            'mal_mirror_ANIME',
            'mal_mirror_MANGA',
            'retry_queue_ANIME',
            'retry_queue_MANGA',
            'force_mirror_refresh',
            'mal_idmap_ANIME',
            'mal_idmap_MANGA',
            'last_full_sync'
          ]) {
            m.legacy.del(k);
          }
          for (const t of TYPES) {
            if (!m.legacy.get(`last_run_${t}`, 0) && m.legacy.get(`last_sync_${t}`, 0)) {
              m.legacy.set(`last_run_${t}`, m.legacy.get(`last_sync_${t}`, 0));
            }
          }
        }

        // @migration(from: "v0.9.1", kind: "storage", sunset: "2-3 releases")
        const pairs: Array<[string, string]> = [
          ['sync_onboarded', 'sync_onboarded'],
          ['sync_retry_at', 'sync_retry_at'],
          ['sync_account', 'sync_account'],
          ['sync_pending_deletes', 'pending_deletes'],
          ...TYPES.flatMap((t): Array<[string, string]> => [
            [`last_sync_${t}`, `last_sync_${t}`],
            [`last_run_${t}`, `last_run_${t}`],
            [`last_compare_${t}`, `last_compare_${t}`],
            [`sync_idmap_${t}`, `idmap_${t}`],
            [`sync_settled_${t}`, `settled_${t}`]
          ])
        ];
        for (const [oldKey, newKey] of pairs) {
          const val = m.legacy.get<any>(oldKey, undefined);
          if (val !== undefined) {
            if (m.storage.get<any>(newKey, undefined) === undefined) {
              m.storage.set(newKey, val);
            }
            m.legacy.del(oldKey);
          }
        }

        for (const t of TYPES) {
          const rawIds = m.storage.get<any>(`idmap_${t}`, undefined);
          if (rawIds !== undefined) {
            try {
              const parsed = typeof rawIds === 'string' ? JSON.parse(rawIds) : rawIds;
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                stores[t].ids.data = parsed;
              }
            } catch {}
          }
          const rawSettled = m.storage.get<any>(`settled_${t}`, undefined);
          if (rawSettled !== undefined) {
            try {
              const parsed = typeof rawSettled === 'string' ? JSON.parse(rawSettled) : rawSettled;
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                stores[t].settled.data = parsed;
              }
            } catch {}
          }
        }

        m.storage.set('schema', 3);
        m.legacy.del('sync_schema');
        m.legacy.del('sync_lock_heartbeat');
      }, 'sync schema upgrade');
    }
  },
  setup(ctx) {
    setSyncLog(ctx.log);
    setSyncGet(ctx.get);
    setSyncStorage(ctx.storage);
    setSyncApi(ctx.api);
    initSyncStores(ctx.persistent);
    initDeletionInterceptor(ctx);

    ctx.menuCommand('🗑️ AL→MAL Sync: Reset all data', () => {
      syncStore.clearKnown();
      ctx.api.clearViewer();
      ctx.accounts.clearSecrets('mal');
      ctx.storage.clear();
      for (const t of TYPES) {
        clearCache(stores[t].ids);
        clearCache(stores[t].settled);
      }
      log('All stored data cleared.');
      renderPanel();
    });

    ctx.menuCommand('🟦 AL→MAL Sync: Disconnect MAL', () => {
      ctx.accounts.disconnect('mal');
      log('MAL disconnected.');
      renderPanel();
    });

    if (location.hostname === 'anilist.co') {
      initSyncPanel(ctx);
    }

    ctx.onCleanup(() => {
      if (syncStatus.syncing) syncStatus.cancelled = true;
      releaseLock();
      setSyncLog(null);
      setSyncGet(null);
      setSyncStorage(null);
      setSyncApi(null);
    });
  }
});

defineModule({
  id: 'manualOverrides',
  key: MANUAL_OVERRIDES_ENABLED_KEY,
  section: 'External Links, Downloads & Mappings',
  layer: 'service',
  requiresReload: false,
  legacy: [MANUAL_OVERRIDES_ENABLED_KEY],
  title: 'Manual Mappings & Sync Audit',
  help: 'Manage custom MyAnimeList ID overrides, entries ignored from sync, and review database discrepancies.',
  options: [
    {
      key: OVERRIDES_SETTING_KEY,
      type: 'json',
      def: {},
      legacy: [OVERRIDES_SETTING_KEY],
      title: 'Manual Overrides & Audit',
      help: 'Configure custom AniList → MyAnimeList ID mappings, ignore titles, and audit unmatched or orphaned entries.',
      validate: validateOverrides,
      editor: openOverridesModal
    }
  ],
  migrate(m) {
    // @migration(from: "v0.8.0", kind: "storage", sunset: "2-3 releases")
    if (!m.settings.has(MANUAL_OVERRIDES_ENABLED_KEY) && Object.keys(getManualOverrides()).length > 0) {
      m.settings.set(MANUAL_OVERRIDES_ENABLED_KEY, true);
    }
  },
  setup(ctx) {
    ctx.onCleanup(configureOverridesModalStyle(ctx.addStyle));
    ctx.services.provide('quickEdit', (mediaId: number, mediaType: SyncMediaType = 'ANIME') =>
      openQuickOverrideModal(
        mediaId,
        mediaType,
        ctx.addStyle,
        () => ctx.events.emit('manualOverrides:changed', mediaId),
        ctx.api
      )
    );
  }
});
