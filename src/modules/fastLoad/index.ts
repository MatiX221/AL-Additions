import { defineModule } from '../../core/registry';
import { detectFastLoad, isBuiltInRunning, markBuiltIn } from '../../utils/standalone';
import { CFG, GQL_ORIGIN, MEDIA_ORIGIN, attempt } from './config';
import {
  win,
  doc,
  setCoreHooks,
  setCoreSession,
  setCoreStorage,
  setFastLoadLogs,
  initUserMap,
  registerGlobalBridges,
  getViewerFromWindow,
  rememberUser,
  incEpoch,
  setFreshFloor,
  store as gqlStore,
  rpcCache,
  rpcInflight,
  userMap,
  idToUserMap,
  inflight,
  navListeners,
  clearGlobalCache
} from './state';
import { installLazyMedia, installRowSkipping, installObserverCoalescing } from './domOptimizers';
import { hookWorker, clearLastAuth } from './worker';
import { loadRoutes, triggerEarlyStart, scheduleAutoPrefetch, installPointerPrefetch } from './routes';
import { installGraphQLLayer } from './graphql';

defineModule({
  id: 'fastLoad',
  key: 'fastLoadEnabled',
  section: 'AniList Enhancements',
  layer: 'intercept',
  requiresReload: true,
  title: 'AniList Fast Load',
  help: 'Performance optimizer: lazy media, off-screen row skipping, observer coalescing, safe GraphQL cache/de-duplication with stale fallback, navigation prefetch and early request start.',
  debug: {
    label: 'Fast Load',
    title: 'Fast Load Debug',
    help: 'Log GraphQL caching, prefetching, deduplication, and Web Worker RPC activity.',
    channels: {
      rpc: {
        label: 'RPC',
        title: 'Web Worker RPC',
        debug: true,
        help: 'Log Web Worker RPC requests, cache hits/misses, and prefetches.'
      }
    }
  },
  standalone: {
    name: 'AniList Fast Load',
    probe: () => !!(win.__ANILIST_FAST_LOAD__ || win.__ANILIST_FAST_LOAD_V4__) && !isBuiltInRunning('fastLoad')
  },
  migrate(m) {
    // @migration(from: "v0.9.1", kind: "cleanup", sunset: "2-3 releases")
    m.legacy.del('alfl:workerUrl');
    m.legacy.del('alfl:rpc:listTpl:v2');
    if (!m.storage.get<boolean>('localStorageCleaned', false) && !detectFastLoad()) {
      for (const k of [
        'alfl:taxonomy:v1',
        'alfl:routes:v1',
        'alfl:routes:v2',
        'alfl:routes:v3',
        'alfl:routes:v4',
        'alfl:userMap',
        'alfl:workerUrl',
        'alfl:rpc:listTpl:v2'
      ]) {
        m.legacy.delLocal(k);
      }
      m.storage.set('localStorageCleaned', true);
    }
  },
  setup(ctx) {
    if (win.top !== win.self) return;
    if (win.__ANILIST_FAST_LOAD__ || win.__ANILIST_FAST_LOAD_V4__) {
      ctx.setStandalonePaused(true);
      ctx.log.warn(
        'Built-in Fast Load skipped: the standalone AniList Fast Load script is already running. Uninstall it to use the built-in version.'
      );
      return;
    }

    win.__ALA_FAST_LOAD__ = '0.4.3';
    markBuiltIn('fastLoad');
    setCoreHooks(ctx.hooks);
    setCoreSession(ctx.session);
    setCoreStorage(ctx.storage);
    setFastLoadLogs(ctx.log, ctx.log.channel('rpc'));

    ctx.hooks.registerCacheBridge({
      getGqlStore: () => gqlStore,
      getRpcCache: () => rpcCache,
      getRpcInflight: () => rpcInflight,
      getUserMap: () => userMap,
      getIdMap: () => idToUserMap,
      clear: () => clearGlobalCache(),
      clearAuth: () => clearLastAuth()
    });

    let yieldedToStandalone = false;
    const yielded = (): boolean => {
      if (yieldedToStandalone) return true;
      if (win.__ANILIST_FAST_LOAD__ || win.__ANILIST_FAST_LOAD_V4__) {
        yieldedToStandalone = true;
        ctx.hooks.markFetchOwner(false);
        ctx.setStandalonePaused(true);
        ctx.log.warn(
          'Built-in Fast Load paused: the standalone AniList Fast Load script is installed. Uninstall it to use the built-in version.'
        );
      }
      return yieldedToStandalone;
    };

    attempt(() => {
      const parent = doc.head || doc.documentElement;
      for (const [href, cors] of [
        [GQL_ORIGIN, true],
        [MEDIA_ORIGIN, false],
        ['https://fonts.googleapis.com', false],
        ['https://fonts.gstatic.com', true]
      ] as const) {
        if (parent.querySelector(`link[rel="preconnect"][href="${href}"]`)) continue;
        const link = doc.createElement('link');
        link.rel = 'preconnect';
        link.href = href;
        if (cors) link.crossOrigin = '';
        parent.appendChild(link);
      }
    });

    navListeners.length = 0;
    ctx.onNav(() => navListeners.forEach(attempt));

    initUserMap();
    registerGlobalBridges();

    attempt(() => {
      const viewer = getViewerFromWindow();
      if (viewer.name && viewer.id) {
        rememberUser(viewer.name, viewer.id);
        ctx.session.recordHint({ userId: viewer.id, username: viewer.name });
      } else if (viewer.name) {
        ctx.session.recordHint({ username: viewer.name });
      }
    });

    let hiddenAt = 0;
    ctx.listen(doc, 'visibilitychange', () => {
      if (doc.hidden) {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt && Date.now() - hiddenAt > 10 * 60_000) {
        incEpoch();
        setFreshFloor(Date.now());
      }
      inflight.clear();
    });

    if (CFG.gqlTtl > 0 && typeof win.fetch === 'function') {
      const uninstallFetch = installGraphQLLayer(yielded);
      ctx.hooks.markFetchOwner(true);
      ctx.onCleanup(() => {
        ctx.hooks.markFetchOwner(false);
        uninstallFetch();
      });
      hookWorker(yielded);
    }
    if (CFG.coalesceObservers) attempt(installObserverCoalescing);
    if (CFG.lazyMedia) attempt(installLazyMedia);
    if (CFG.rowSkipping) attempt(installRowSkipping);

    if (CFG.earlyStart) {
      loadRoutes();
      triggerEarlyStart(yielded);
      navListeners.push(() => triggerEarlyStart(yielded));
    } else if (CFG.prefetch) {
      loadRoutes();
    }

    if (CFG.prefetch) {
      navListeners.push(() => scheduleAutoPrefetch(yielded, 500));
      ctx.ready(() => scheduleAutoPrefetch(yielded, 1000));
      installPointerPrefetch(yielded, ctx.listen);
    }

    ctx.onCleanup(() => {
      navListeners.length = 0;
      setFastLoadLogs(null, null);
      setCoreStorage(null);
      setCoreSession(null);
      setCoreHooks(null);
    });
  }
});
