import { defineModule } from '../../core/registry';
import { log } from '../../api/mal';
import {
  MANUAL_OVERRIDES_ENABLED_KEY,
  OVERRIDES_SETTING_KEY,
  getManualOverrides,
  validateOverrides
} from '../../api/malOverrides';
import { store, safe } from '../../utils/helpers';
import { ANILIST_SESSION_KEYS, SETTING_PREFIX, type SyncMediaType } from '../../types';
import { TYPES } from './types';
import { stores, clearCache, PENDING_DELETES_KEY, syncStatus } from './state';
import { initSyncPanel, renderPanel } from './panel';
import { configureOverridesModalStyle, openQuickOverrideModal } from './overridesModal';
import { initDeletionInterceptor } from './deletionInterceptor';

const SYNC_DATA_KEYS = [
  ...ANILIST_SESSION_KEYS,
  'sync_schema',
  'sync_lock_heartbeat',
  'sync_onboarded',
  'sync_retry_at',
  'sync_account',
  PENDING_DELETES_KEY,
  ...TYPES.flatMap((t) => [`last_sync_${t}`, `last_run_${t}`, `last_compare_${t}`])
];

defineModule({
  id: 'sync',
  key: 'syncEnabled',
  section: 'Sync',
  hosts: ['anilist.co', 'myanimelist.net'],
  layer: 'service',
  requiresReload: false,
  accounts: ['mal'],
  def: false,
  legacy: ['syncEnabled', 'syncOn'],
  title: 'AniList → MyAnimeList Sync',
  help: 'Enable sync and show the list page sync panel',
  debug: {
    key: 'debugSync',
    title: 'Sync Debug',
    help: 'Log MAL synchronization steps, queue processing, rate limits, and deletions.',
    pattern: /^\[SYNC/i
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
  migrate() {
    if (store.get('sync_schema', 0) < 2) {
      safe(() => {
        for (const k of [
          'mal_mirror_ANIME',
          'mal_mirror_MANGA',
          'retry_queue_ANIME',
          'retry_queue_MANGA',
          'force_mirror_refresh',
          'mal_idmap_ANIME',
          'mal_idmap_MANGA',
          'last_full_sync'
        ])
          store.del(k);
        for (const t of TYPES) {
          if (!store.get(`last_run_${t}`, 0) && store.get(`last_sync_${t}`, 0))
            store.set(`last_run_${t}`, store.get(`last_sync_${t}`, 0));
        }
        store.set('sync_schema', 2);
      }, 'sync schema upgrade');
    }
  },
  setup(ctx) {
    initDeletionInterceptor();

    ctx.menuCommand('🗑️ AL→MAL Sync: Reset all data', () => {
      SYNC_DATA_KEYS.forEach((k) => store.del(k));
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
    });
  }
});

defineModule({
  id: 'manualOverrides',
  key: MANUAL_OVERRIDES_ENABLED_KEY,
  section: 'External Links, Downloads & Mappings',
  layer: 'service',
  requiresReload: false,
  def: false,
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
      validate: validateOverrides
    }
  ],
  migrate() {
    if (
      store.get(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY, undefined) === undefined &&
      Object.keys(getManualOverrides()).length > 0
    ) {
      store.set(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY, true);
    }
  },
  setup(ctx) {
    ctx.onCleanup(configureOverridesModalStyle(ctx.addStyle));
    ctx.services.provide('quickEdit', (mediaId: number, mediaType: SyncMediaType = 'ANIME') =>
      openQuickOverrideModal(mediaId, mediaType, ctx.addStyle)
    );
  }
});
