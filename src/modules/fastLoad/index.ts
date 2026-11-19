import { defineModule } from '../../core/registry';
import { isBuiltInRunning, markBuiltIn } from '../../utils/standalone';
import { store as gmStore } from '../../utils/helpers';
import { CFG, GQL_ORIGIN, MEDIA_ORIGIN, attempt } from './config';
import {
  win,
  doc,
  setCoreHooks,
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
  def: false,
  title: 'AniList Fast Load',
  help: 'Performance optimizer: lazy media, off-screen row skipping, observer coalescing, safe GraphQL cache/de-duplication with stale fallback, navigation prefetch and early request start.',
  debug: {
    key: 'debugFastLoad',
    title: 'Fast Load Debug',
    help: 'Log Web Worker RPC requests, cache hits/misses, deduplication, and prefetch activity.',
    pattern: /^\[(?:FASTLOAD|ALFL)/i
  },
  standalone: {
    name: 'AniList Fast Load',
    probe: () => !!(win.__ANILIST_FAST_LOAD__ || win.__ANILIST_FAST_LOAD_V4__) && !isBuiltInRunning('fastLoad')
  },
  setup(ctx) {
    if (win.top !== win.self) return;
    if (win.__ANILIST_FAST_LOAD__ || win.__ANILIST_FAST_LOAD_V4__) {
      ctx.setStandalonePaused(true);
      console.warn(
        '[AL-Additions] Built-in Fast Load skipped: the standalone AniList Fast Load script is already running. Uninstall it to use the built-in version.'
      );
      return;
    }

    win.__ALA_FAST_LOAD__ = '0.4.3';
    markBuiltIn('fastLoad');
    setCoreHooks(ctx.hooks);

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
        console.warn(
          '[AL-Additions] Built-in Fast Load paused: the standalone AniList Fast Load script is installed. Uninstall it to use the built-in version.'
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
        gmStore.set('al_user_id', viewer.id);
        gmStore.set('al_username', viewer.name);
      } else if (viewer.name) {
        gmStore.set('al_username', viewer.name);
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
      setCoreHooks(null);
    });
  }
});
