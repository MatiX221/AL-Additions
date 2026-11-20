import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadFreshKernel() {
  vi.resetModules();
  const [types, helpers, observer, bus, accounts, settings, devMode, registry, anilist] = await Promise.all([
    import('../src/types'),
    import('../src/utils/helpers'),
    import('../src/core/observer'),
    import('../src/core/bus'),
    import('../src/core/accounts'),
    import('../src/settings/settings'),
    import('../src/settings/devMode'),
    import('../src/core/registry'),
    import('../src/api/anilist')
  ]);

  registry.configureCoreServices({
    api: anilist.anilistApiClient,
    session: anilist.AniList.session
  });

  return {
    types,
    helpers,
    observer,
    bus,
    accounts,
    settings,
    devMode,
    registry,
    anilist
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Lane 2: Registry, Accounts & Debug Helpers', () => {
  it('B1-04: ignores async rc.mount() after rc.signal aborts, cleans abort listener on manual unmount, and isolates throwing onRoute matchers', async () => {
    const { registry, settings, observer } = await loadFreshKernel();
    const readySpy = vi.spyOn(observer.Core, 'ready');
    const navSpy = vi.spyOn(observer.Core, 'onNavigate');
    const bodySpy = vi.spyOn(observer.Core, 'onBodyMutation');
    const ownUiSpy = vi.spyOn(observer.Core, 'registerOwnUi');

    let resolveAsyncData!: () => void;
    let routeRc!: any;
    let manualUnmount!: () => void;
    let addSpy!: ReturnType<typeof vi.spyOn>;
    let removeSpy!: ReturnType<typeof vi.spyOn>;
    let matcherShouldThrow = true;
    const mountedLog: string[] = [];

    document.body.innerHTML = '<div id="anchor-node"></div>';
    history.replaceState({}, '', '/anime/101');

    registry.defineModule({
      id: 'routeMountMod',
      key: 'routeMountEnabled',
      title: 'Route Mount',
      help: 'Test',
      setup(ctx) {
        ctx.onRoute(
          () => {
            if (matcherShouldThrow) throw new Error('matcher boom');
            return false;
          },
          () => {
            mountedLog.push('should-not-run');
          }
        );

        ctx.onRoute(/\/anime\/\d+/, async (rc) => {
          routeRc = rc;
          await new Promise<void>((res) => {
            resolveAsyncData = res;
          });
          rc.mount({
            id: 'stale-route-widget',
            anchor: '#anchor-node',
            ownUi: true,
            create: () => {
              const el = document.createElement('div');
              el.id = 'stale-route-widget';
              mountedLog.push('stale-created');
              return el;
            }
          });
        });

        ctx.onRoute(/\/manga\/\d+/, (rc) => {
          addSpy = vi.spyOn(rc.signal, 'addEventListener');
          removeSpy = vi.spyOn(rc.signal, 'removeEventListener');
          manualUnmount = rc.mount({
            id: 'manual-route-widget',
            anchor: '#anchor-node',
            create: () => {
              const el = document.createElement('div');
              el.id = 'manual-route-widget';
              return el;
            }
          });
        });
      }
    });

    settings.Settings.set('routeMountEnabled', true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => registry.startModules(false)).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(1);
      matcherShouldThrow = false;

      readySpy.mockClear();
      navSpy.mockClear();
      bodySpy.mockClear();
      ownUiSpy.mockClear();

      history.pushState({}, '', '/home');
      expect(routeRc.signal.aborted).toBe(true);

      resolveAsyncData();
      await Promise.resolve();
      await Promise.resolve();

      expect(document.getElementById('stale-route-widget')).toBeNull();
      expect(mountedLog).toEqual([]);
      expect(readySpy).not.toHaveBeenCalled();
      expect(navSpy).not.toHaveBeenCalled();
      expect(bodySpy).not.toHaveBeenCalled();
      expect(ownUiSpy).not.toHaveBeenCalled();

      history.pushState({}, '', '/manga/55');
      expect(typeof manualUnmount).toBe('function');
      expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(document.getElementById('manual-route-widget')).not.toBeNull();
      manualUnmount();
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(document.getElementById('manual-route-widget')).toBeNull();
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
      history.replaceState({}, '', '/');
    }
  });

  it('B1-05: blocks stale disposed ctx1 calls from clobbering ctx2, preserves post-unload storage.clear(), and isolates clearing depth & xhr throws', async () => {
    const origWinFetch = window.fetch;
    const baseFetch = vi.fn(async () => new Response(JSON.stringify({ data: { Viewer: { id: 1 } } }), { status: 200 }));
    let unsubGql: (() => void) | null = null;
    const gqlEvents: any[] = [];

    try {
      window.fetch = baseFetch as any;
      const { registry, settings, bus, helpers, observer } = await loadFreshKernel();
      const host = registry.createModuleHost();

      unsubGql = bus.CoreHooks.onGqlFetch((ev) => gqlEvents.push(ev));
      expect(window.fetch).not.toBe(baseFetch);

      let bootCount = 0;
      let ctx1!: any;
      let ctx2!: any;
      let fetchOwnerAfterCtx1Cleanup: boolean | undefined;
      let fallbackArmedAfterCtx1Cleanup = false;
      const lateWatch: { cb: ((name: string, oldV: any, newV: any, remote?: boolean) => void) | null } = {
        cb: null
      };
      const liveLog: string[] = [];

      const origGmWatch = globalThis.GM_addValueChangeListener;
      vi.spyOn(globalThis, 'GM_addValueChangeListener').mockImplementation((...args: any[]) => {
        const [key, cb] = args;
        if (key === 'ala_mod_ctxReloadMod_watched') lateWatch.cb = cb;
        return origGmWatch(key, cb);
      });

      const bridge2 = {
        getGqlStore: () => undefined,
        getRpcCache: () => undefined,
        getRpcInflight: () => undefined,
        getUserMap: () => undefined,
        getIdMap: () => undefined,
        clear: vi.fn(),
        clearAuth: vi.fn()
      };
      const bridge1 = { ...bridge2, clear: vi.fn(), clearAuth: vi.fn() };

      const regMenuSpy = vi.spyOn(globalThis, 'GM_registerMenuCommand');

      registry.defineModule({
        id: 'ctxReloadMod',
        key: 'ctxReloadEnabled',
        layer: 'feature',
        title: 'Ctx Reload',
        help: 'Test',
        setup(ctx) {
          bootCount++;
          if (bootCount === 1) {
            ctx1 = ctx;
            ctx.hooks.markFetchOwner(true);
            ctx.onCleanup(() => ctx.hooks.markFetchOwner(false));
            ctx.storage.set('k', 'v1');
            ctx.storage.watch('watched', (_k, _o, n) => liveLog.push(`watch1:${n}`));
            ctx.hooks.setSessionClearing(true);
            ctx.hooks.setSessionClearing(true);
          } else {
            fetchOwnerAfterCtx1Cleanup = (globalThis as any).__alaCoreMirror?.fetchOwner;
            fallbackArmedAfterCtx1Cleanup = window.fetch !== baseFetch;
            ctx2 = ctx;
            ctx.hooks.registerCacheBridge(bridge2);
            ctx.hooks.markFetchOwner(true);
            ctx.onCleanup(() => ctx.hooks.markFetchOwner(false));
            ctx.services.provide('svc' as never, 'v2-impl' as never);
            ctx.menuCommand('Shared Cmd', () => liveLog.push('menu:v2'));
            ctx.storage.set('k', 'v2');
            ctx.events.on('manualOverrides:changed', (id) => liveLog.push(`ev2:${id}`));
          }
        }
      });

      registry.defineModule({
        id: 'otherClearingMod',
        key: 'otherClearingEnabled',
        layer: 'service',
        title: 'Other Clearing',
        help: 'Test',
        setup(ctx) {
          ctx.hooks.setSessionClearing(true);
        }
      });

      settings.Settings.set('ctxReloadEnabled', true);
      settings.Settings.set('otherClearingEnabled', true);
      registry.startModules(false);

      expect(bus.CoreHooks.isSessionClearing()).toBe(true);
      expect((globalThis as any).__alaCoreMirror?.fetchOwner).toBe(true);
      expect(window.fetch).toBe(baseFetch);

      host.reload(['ctxReloadMod']);
      expect(bootCount).toBe(2);
      expect(fetchOwnerAfterCtx1Cleanup).toBe(false);
      expect(fallbackArmedAfterCtx1Cleanup).toBe(true);
      expect((globalThis as any).__alaCoreMirror?.fetchOwner).toBe(true);
      expect(window.fetch).toBe(baseFetch);
      expect(bus.CoreHooks.isSessionClearing()).toBe(true);

      bus.EventBus.emitRetained('manualOverrides:changed', 777);
      const readySpy = vi.spyOn(observer.Core, 'ready');
      const navSpy = vi.spyOn(observer.Core, 'onNavigate');
      const bodySpy = vi.spyOn(observer.Core, 'onBodyMutation');
      const ownUiSpy = vi.spyOn(observer.Core, 'registerOwnUi');
      const gqlSpy = vi.spyOn(bus.CoreHooks, 'onGqlFetch');
      const rpcSpy = vi.spyOn(bus.CoreHooks, 'blockRpc');
      const prefetchSpy = vi.spyOn(bus.CoreHooks, 'setPrefetchPaused');
      const clearAuthSpy = vi.spyOn(bus.CoreHooks, 'clearAuth');
      const emitGqlSpy = vi.spyOn(bus.CoreHooks, 'emitGqlFetch');
      const staleCb = vi.fn();

      ctx1.setStandalonePaused(true);
      ctx1.setStandalonePaused(false);
      expect(host.getStatus('ctxReloadMod')).toEqual({ active: true });

      ctx1.hooks.registerCacheBridge(bridge1);
      expect(bus.CoreHooks.getCacheBridge()).toBe(bridge2);

      ctx1.hooks.markFetchOwner(false);
      ctx1.onCleanup(() => ctx1.hooks.markFetchOwner(false));
      expect((globalThis as any).__alaCoreMirror?.fetchOwner).toBe(true);
      expect(window.fetch).toBe(baseFetch);

      ctx1.hooks.clearAuth();
      expect(clearAuthSpy).not.toHaveBeenCalled();
      expect(bridge2.clearAuth).not.toHaveBeenCalled();

      ctx1.hooks.emitGqlFetch({
        phase: 'request',
        url: '/graphql',
        query: 'query StaleEmit { Viewer { id } }',
        variables: {}
      });
      expect(emitGqlSpy).not.toHaveBeenCalled();
      expect(gqlEvents).toEqual([]);

      ctx2.hooks.clearAuth();
      expect(clearAuthSpy).toHaveBeenCalledTimes(1);
      expect(bridge2.clearAuth).toHaveBeenCalledTimes(1);
      ctx2.hooks.emitGqlFetch({
        phase: 'request',
        url: '/graphql',
        query: 'query LiveEmit { Viewer { id } }',
        variables: {}
      });
      expect(emitGqlSpy).toHaveBeenCalledTimes(1);
      expect(gqlEvents).toHaveLength(1);
      gqlEvents.length = 0;

      ctx1.services.provide('svc', 'v1-stale');
      expect(bus.ServiceRegistry.get('ctxReloadMod:svc' as any)).toBe('v2-impl');

      ctx1.menuCommand('Shared Cmd', () => liveLog.push('menu:v1-stale'));
      expect(regMenuSpy).toHaveBeenCalledTimes(1);
      (regMenuSpy.mock.calls[0][1] as () => void)();
      expect(liveLog).toContain('menu:v2');
      expect(liveLog).not.toContain('menu:v1-stale');

      ctx1.ready(staleCb);
      ctx1.onNav(staleCb);
      ctx1.onBodyMutation(staleCb);
      ctx1.onRoute(staleCb);
      ctx1.ownUi('#stale-ui');
      ctx1.addStyle('stale-style-id', 'body{color:red}');
      ctx1.hooks.onGqlFetch(staleCb);
      ctx1.hooks.blockRpc(() => true);
      ctx1.hooks.setPrefetchPaused(true);
      expect(readySpy).not.toHaveBeenCalled();
      expect(navSpy).not.toHaveBeenCalled();
      expect(bodySpy).not.toHaveBeenCalled();
      expect(ownUiSpy).not.toHaveBeenCalled();
      expect(document.getElementById('stale-style-id')).toBeNull();
      expect(gqlSpy).not.toHaveBeenCalled();
      expect(rpcSpy).not.toHaveBeenCalled();
      expect(prefetchSpy).not.toHaveBeenCalled();
      expect(bus.CoreHooks.isPrefetchSuppressed()).toBe(false);
      expect(staleCb).not.toHaveBeenCalled();

      ctx1.events.on('manualOverrides:changed', staleCb);
      ctx1.events.onRetained('manualOverrides:changed', staleCb);
      ctx1.events.emitRetained('manualOverrides:changed', 888);
      ctx1.services.onAvailable('ctxReloadMod:svc', staleCb);
      ctx1.events.emit('manualOverrides:changed', 999);
      expect(staleCb).not.toHaveBeenCalled();
      expect(liveLog).not.toContain('ev2:888');
      expect(liveLog).not.toContain('ev2:999');

      ctx1.storage.watch('watched', staleCb);
      ctx2.storage.set('watched', 'live-update');
      expect(lateWatch.cb).not.toBeNull();
      lateWatch.cb?.('ala_mod_ctxReloadMod_watched', 'old', 'late-gm', false);
      expect(liveLog).not.toContain('watch1:live-update');
      expect(liveLog).not.toContain('watch1:late-gm');

      ctx1.storage.set('k', 'stale-overwrite');
      ctx1.storage.del('k');
      expect(ctx2.storage.get('k')).toBe('v2');

      ctx1.hooks.setSessionClearing(false);
      ctx1.hooks.setSessionClearing(false);
      expect(bus.CoreHooks.isSessionClearing()).toBe(true);

      ctx2.hooks.setSessionClearing(false);
      expect(bus.CoreHooks.isSessionClearing()).toBe(true);

      settings.Settings.set('otherClearingEnabled', false);
      host.reload(['otherClearingMod']);
      expect(bus.CoreHooks.isSessionClearing()).toBe(false);

      settings.Settings.set('ctxReloadEnabled', false);
      host.reload(['ctxReloadMod']);
      expect((globalThis as any).__alaCoreMirror?.fetchOwner).toBe(false);
      expect(window.fetch).not.toBe(baseFetch);

      await window.fetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query FallbackAfterUnload { Viewer { id } }' })
      });
      expect(baseFetch).toHaveBeenCalledTimes(1);
      expect(gqlEvents.map((e) => ({ phase: e.phase, query: e.query }))).toEqual([
        { phase: 'request', query: 'query FallbackAfterUnload { Viewer { id } }' },
        { phase: 'response', query: 'query FallbackAfterUnload { Viewer { id } }' }
      ]);

      clearAuthSpy.mockClear();
      emitGqlSpy.mockClear();
      gqlEvents.length = 0;
      ctx2.hooks.markFetchOwner(true);
      ctx2.onCleanup(() => ctx2.hooks.markFetchOwner(true));
      ctx2.hooks.clearAuth();
      ctx2.hooks.emitGqlFetch({
        phase: 'request',
        url: '/graphql',
        query: 'query StalePostUnload { Viewer { id } }',
        variables: {}
      });
      expect((globalThis as any).__alaCoreMirror?.fetchOwner).toBe(false);
      expect(clearAuthSpy).not.toHaveBeenCalled();
      expect(emitGqlSpy).not.toHaveBeenCalled();
      expect(gqlEvents).toEqual([]);

      helpers.store.set('al_user_id', 700);
      helpers.store.set('al_username', 'LiveUser');
      bus.CoreHooks.setAuthHeader('Bearer live-token');

      ctx1.session.clear();
      ctx1.session.recordHint({ userId: 999, username: 'StaleUser' });
      ctx1.api.session.clear();
      ctx1.api.session.recordHint({ userId: 999, username: 'StaleUser' });
      ctx1.hooks.setAuthHeader('Bearer stale-token');
      ctx1.hooks.setAuthHeader(null);

      expect(helpers.store.get('al_user_id', null)).toBe(700);
      expect(helpers.store.get('al_username', null)).toBe('LiveUser');
      expect(bus.CoreHooks.getAuthHeader()).toBe('Bearer live-token');

      const staleAccWatch = vi.fn();
      ctx1.accounts.watch('mal', staleAccWatch);
      helpers.store.set('mal_token', 'tok_stale_test');
      expect(staleAccWatch).not.toHaveBeenCalled();

      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        settings.Settings.set('devModeEnabled', true);
        (ctx1.log.debug as any)('disposed-debug');
        ctx1.log.warn('disposed-warn');
        ctx1.log.error('disposed-error');
        expect(debugSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('[Ctx Reload]', 'disposed-warn');
        expect(logErrSpy).toHaveBeenCalledWith('[Ctx Reload]', 'disposed-error');
      } finally {
        debugSpy.mockRestore();
        warnSpy.mockRestore();
        logErrSpy.mockRestore();
      }

      expect(helpers.store.get('ala_mod_ctxReloadMod_k', null)).toBe('v2');
      ctx2.storage.clear();
      expect(helpers.store.get('ala_mod_ctxReloadMod_k', null)).toBeNull();

      registry.defineModule({
        id: 'xhrThrowMod',
        key: 'xhrThrowEnabled',
        title: 'XHR Throw',
        help: 'Test',
        setup(ctx) {
          ctx1 = ctx;
        }
      });
      settings.Settings.set('xhrThrowEnabled', true);
      host.reload(['xhrThrowMod']);
      const xhrSpy = vi.spyOn(globalThis, 'GM_xmlhttpRequest').mockImplementation(() => {
        throw new Error('sync xhr crash');
      });
      await expect(ctx1.http.request('https://example.com')).rejects.toThrow('sync xhr crash');
      await expect(ctx1.http.text('https://example.com')).rejects.toThrow('sync xhr crash');

      xhrSpy.mockImplementation((details: any) => {
        details.onload?.({ status: 200, responseText: 'ok-before-throw' });
        throw new Error('post-onload sync crash');
      });
      await expect(ctx1.http.request('https://example.com')).resolves.toEqual({
        status: 200,
        responseText: 'ok-before-throw'
      });
      await expect(ctx1.http.text('https://example.com')).resolves.toBe('ok-before-throw');

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        settings.Settings.set('xhrThrowEnabled', false);
        expect(() => host.reload(['xhrThrowMod'])).not.toThrow();
        expect(host.getStatus('xhrThrowMod')).toEqual({ active: false, reason: 'disabled' });
        expect(errSpy).not.toHaveBeenCalled();
        await expect(ctx1.http.text('https://example.com')).rejects.toThrow('Request aborted');
      } finally {
        errSpy.mockRestore();
      }
    } finally {
      unsubGql?.();
      window.fetch = origWinFetch;
    }
  });

  it('B1-06: preserves missingDeps on sync dep failure in startModules/reload and cascades disposeFeature cleanly', async () => {
    const { registry, settings } = await loadFreshKernel();
    const host = registry.createModuleHost();
    const statusEvents: Array<[string, any]> = [];
    const teardownOrder: string[] = [];
    let shouldParentThrow = true;

    host.onStatusChange((id, status) => statusEvents.push([id, status]));

    registry.defineModule({
      id: 'depParent',
      key: 'depParentEnabled',
      layer: 'service',
      title: 'Dep Parent',
      help: 'Test',
      setup(ctx) {
        ctx.onCleanup(() => teardownOrder.push('depParent'));
        if (shouldParentThrow) throw new Error('parent sync fail');
      }
    });
    registry.defineModule({
      id: 'depChild',
      key: 'depChildEnabled',
      layer: 'feature',
      dependsOn: ['depParent'],
      title: 'Dep Child',
      help: 'Test',
      setup(ctx) {
        ctx.onCleanup(() => teardownOrder.push('depChild'));
      }
    });
    registry.defineModule({
      id: 'depGrandChild',
      key: 'depGrandChildEnabled',
      layer: 'feature',
      dependsOn: ['depChild'],
      title: 'Dep Grandchild',
      help: 'Test',
      setup(ctx) {
        ctx.onCleanup(() => teardownOrder.push('depGrandChild'));
      }
    });

    settings.Settings.set('depParentEnabled', true);
    settings.Settings.set('depChildEnabled', true);
    settings.Settings.set('depGrandChildEnabled', true);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.startModules(false);
      expect(host.getStatus('depParent')).toEqual({
        active: false,
        reason: 'error',
        error: 'parent sync fail'
      });
      expect(host.getStatus('depChild')).toEqual({
        active: false,
        reason: 'dep-unavailable',
        missingDeps: ['depParent']
      });
      expect(host.getStatus('depGrandChild')).toEqual({
        active: false,
        reason: 'dep-unavailable',
        missingDeps: ['depChild']
      });
      const childDepEvents = statusEvents.filter(
        ([id, st]) => id === 'depChild' && st.reason === 'dep-unavailable'
      );
      expect(childDepEvents).toHaveLength(1);

      statusEvents.length = 0;
      host.reload(['depParent']);
      expect(host.getStatus('depChild')).toEqual({
        active: false,
        reason: 'dep-unavailable',
        missingDeps: ['depParent']
      });
      expect(
        statusEvents.filter(([id, st]) => id === 'depChild' && st.reason === 'dep-unavailable')
      ).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }

    shouldParentThrow = false;
    host.reload(['depParent']);
    expect(host.getStatus('depParent')).toEqual({ active: true });
    expect(host.getStatus('depChild')).toEqual({ active: true });
    expect(host.getStatus('depGrandChild')).toEqual({ active: true });

    teardownOrder.length = 0;
    registry.disposeFeature('depParent');
    expect(teardownOrder).toEqual(['depGrandChild', 'depChild', 'depParent']);
    expect(host.getStatus('depParent')).toEqual({ active: false, reason: 'disabled' });
    expect(host.getStatus('depChild')).toEqual({
      active: false,
      reason: 'dep-unavailable',
      missingDeps: ['depParent']
    });
    expect(host.getStatus('depGrandChild')).toEqual({
      active: false,
      reason: 'dep-unavailable',
      missingDeps: ['depChild']
    });

    registry.disposeFeature('depParent');
    registry.disposeFeature('nonExistentMod');
    expect(host.getStatus('depParent')).toEqual({ active: false, reason: 'disabled' });
    expect(host.getStatus('depChild')).toEqual({
      active: false,
      reason: 'dep-unavailable',
      missingDeps: ['depParent']
    });
  });

  it('B1-07: enforces symmetrical ctx.log & ctx.log.channel() gating, frozen metadata, { debug: false } zero-setting mode, and compile-time checks', async () => {
    const { registry, settings } = await loadFreshKernel();
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let plainCtx!: any;
    let quietCtx!: any;
    let simpleCtx!: any;
    let multiCtx!: any;

    try {
      registry.defineModule({
        id: 'plainMod',
        key: 'plainModEnabled',
        title: 'Plain Module',
        help: 'No debug config',
        setup(ctx) {
          plainCtx = ctx;
          expect(ctx.title).toBe('Plain Module');
          expect(ctx.help).toBe('No debug config');
          expect(ctx.log.canDebug).toBe(false);
          expect(ctx.log.label).toBe('Plain Module');
          expect(Object.isFrozen(ctx.log)).toBe(true);

          if (false as boolean) {
            // @ts-expect-error debug omitted -> .debug() blocked at compile time
            ctx.log.debug('nope');
            // @ts-expect-error no channels declared
            ctx.log.channel('any');
          }
        }
      });

      registry.defineModule({
        id: 'quietMod',
        key: 'quietModEnabled',
        title: 'Quiet Module',
        help: 'Warn/error custom prefix only',
        debug: {
          debug: false,
          label: 'Quiet',
          channels: {
            sub: { label: 'Sub', debug: false }
          }
        },
        setup(ctx) {
          quietCtx = ctx;
          const sub = ctx.log.channel('sub');
          expect(ctx.log.canDebug).toBe(false);
          expect(sub.canDebug).toBe(false);
          expect(sub.id).toBe('sub');
          expect(Object.isFrozen(sub)).toBe(true);

          if (false as boolean) {
            // @ts-expect-error debug: false module blocks .debug()
            ctx.log.debug('nope');
            // @ts-expect-error debug: false channel blocks .debug()
            sub.debug('nope');
            // @ts-expect-error undeclared channel name
            ctx.log.channel('unknown');
          }
        }
      });

      registry.defineModule({
        id: 'simpleDbgMod',
        key: 'simpleDbgEnabled',
        title: 'Simple Debug Module',
        help: 'Single debug toggle',
        debug: {
          label: 'Simple',
          title: 'Simple Debug',
          help: 'Simple help'
        },
        setup(ctx) {
          simpleCtx = ctx;
          expect(ctx.log.canDebug).toBe(true);
          expect(ctx.log.label).toBe('Simple');
          expect(ctx.log.title).toBe('Simple Debug');
          expect(ctx.log.help).toBe('Simple help');

          if (false as boolean) {
            // @ts-expect-error no channels declared
            ctx.log.channel('rpc');
          }
        }
      });

      registry.defineModule({
        id: 'multiDbgMod',
        key: 'multiDbgEnabled',
        title: 'Multi Debug Module',
        help: 'Multi channel debug',
        debug: {
          label: 'Multi',
          title: 'Multi Debug',
          help: 'Multi help',
          channels: {
            rpc: { label: 'RPC', title: 'Worker RPC', debug: true, help: 'RPC logs' },
            quiet: { label: 'QuietCh', debug: false }
          }
        },
        setup(ctx) {
          multiCtx = ctx;
          const rpc = ctx.log.channel('rpc');
          const quiet = ctx.log.channel('quiet');
          expect(rpc).toBe(ctx.log.channel('rpc'));
          expect(rpc.id).toBe('rpc');
          expect(rpc.label).toBe('RPC');
          expect(rpc.title).toBe('Worker RPC');
          expect(rpc.help).toBe('RPC logs');
          expect(rpc.canDebug).toBe(true);
          expect(Object.isFrozen(rpc)).toBe(true);
          expect(quiet.canDebug).toBe(false);

          if (false as boolean) {
            // @ts-expect-error debug: false channel blocks .debug()
            quiet.debug('blocked');
            // @ts-expect-error undeclared channel name
            ctx.log.channel('missing');
          }
        }
      });

      const defaultDebug = settings.Settings.get('debug');
      expect(defaultDebug.plainMod).toBeUndefined();
      expect(defaultDebug.quietMod).toBeUndefined();
      expect(defaultDebug.simpleDbgMod).toEqual({ enabled: false });
      expect(defaultDebug.multiDbgMod).toEqual({ enabled: false, channels: { general: true, rpc: true } });
      expect(defaultDebug.multiDbgMod.channels.quiet).toBeUndefined();

      settings.Settings.set('plainModEnabled', true);
      settings.Settings.set('quietModEnabled', true);
      settings.Settings.set('simpleDbgEnabled', true);
      settings.Settings.set('multiDbgEnabled', true);
      registry.startModules(false);

      settings.Settings.set('devModeEnabled', true);
      (plainCtx.log.debug as any)('ignored');
      plainCtx.log.warn('plain-w');
      plainCtx.log.error('plain-e');
      expect(debugSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith('[Plain Module]', 'plain-w');
      expect(errSpy).toHaveBeenCalledWith('[Plain Module]', 'plain-e');

      const fallbackCh1 = (plainCtx.log.channel as any)('missing');
      const fallbackCh2 = (plainCtx.log.channel as any)('missing');
      expect(fallbackCh1).toBe(fallbackCh2);
      expect(Object.isFrozen(fallbackCh1)).toBe(true);
      expect(fallbackCh1.canDebug).toBe(false);
      fallbackCh1.debug('ignored');
      fallbackCh1.warn('fb-warn');
      expect(debugSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith('[Plain Module (missing)]', 'fb-warn');

      (quietCtx.log.debug as any)('ignored');
      quietCtx.log.warn('q-root');
      quietCtx.log.channel('sub').error('q-sub');
      expect(debugSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith('[Quiet]', 'q-root');
      expect(errSpy).toHaveBeenCalledWith('[Quiet (Sub)]', 'q-sub');

      expect(simpleCtx.log.enabled()).toBe(false);
      simpleCtx.log.debug('suppressed');
      expect(debugSpy).not.toHaveBeenCalled();

      settings.Settings.set('debug', { simpleDbgMod: { enabled: true } });
      expect(simpleCtx.log.enabled()).toBe(true);
      simpleCtx.log.debug('hello-simple');
      expect(debugSpy).toHaveBeenLastCalledWith('[Simple]', 'hello-simple');

      const rpcLog = multiCtx.log.channel('rpc');
      expect(multiCtx.log.enabled()).toBe(false);
      expect(rpcLog.enabled()).toBe(false);

      settings.Settings.set('debug', { multiDbgMod: { enabled: true } });
      expect(multiCtx.log.enabled()).toBe(true);
      expect(rpcLog.enabled()).toBe(true);
      multiCtx.log.debug('root-msg');
      rpcLog.debug('rpc-msg');
      expect(debugSpy).toHaveBeenCalledWith('[Multi]', 'root-msg');
      expect(debugSpy).toHaveBeenCalledWith('[Multi (RPC)]', 'rpc-msg');

      debugSpy.mockClear();
      settings.Settings.set('debug', {
        multiDbgMod: { enabled: true, channels: { general: false, rpc: true } }
      });
      expect(multiCtx.log.enabled()).toBe(false);
      expect(rpcLog.enabled()).toBe(true);
      multiCtx.log.debug('root-muted');
      rpcLog.debug('rpc-still-on');
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).toHaveBeenCalledWith('[Multi (RPC)]', 'rpc-still-on');

      debugSpy.mockClear();
      settings.Settings.set('devModeEnabled', false);
      expect(rpcLog.enabled()).toBe(false);
      rpcLog.debug('dev-off');
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('tracks ctx.http.download() outcomes and aborts in-flight downloads on unload without opening fallback tab', async () => {
    const { registry, settings } = await loadFreshKernel();
    const host = registry.createModuleHost();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const dlSpy = vi.spyOn(globalThis, 'GM_download');

    let dlCtx!: any;
    registry.defineModule({
      id: 'dlMod',
      key: 'dlModEnabled',
      title: 'Download Mod',
      help: 'Test',
      setup(ctx) {
        dlCtx = ctx;
      }
    });
    settings.Settings.set('dlModEnabled', true);
    registry.startModules(false);

    dlSpy.mockImplementationOnce((opts: any) => {
      opts.onload?.();
      return { abort: vi.fn() };
    });
    await expect(dlCtx.http.download('https://example.com/a.jpg', 'a.jpg')).resolves.toBe('download');
    expect(clickSpy).not.toHaveBeenCalled();

    dlSpy.mockImplementationOnce((opts: any) => {
      opts.onerror?.({ error: 'network' });
      return { abort: vi.fn() };
    });
    await expect(dlCtx.http.download('https://example.com/b.jpg', 'b.jpg')).resolves.toBe('tab');
    expect(clickSpy).toHaveBeenCalledTimes(1);

    clickSpy.mockClear();
    const abortMock = vi.fn();
    dlSpy.mockImplementationOnce((opts: any) => ({
      abort: () => {
        abortMock();
        opts.onabort?.();
      }
    }));

    const pending = dlCtx.http.download('https://example.com/c.jpg', 'c.jpg');
    settings.Settings.set('dlModEnabled', false);
    host.reload(['dlMod']);

    await expect(pending).rejects.toThrow('Download aborted');
    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('provides scoped MigrateContext (storage, settings.has/get/set, legacy) and guards post-migrate writes', async () => {
    const { registry, helpers } = await loadFreshKernel();
    let capturedM!: any;

    helpers.store.set('legacy_old_key', 'from-old');

    registry.defineModule({
      id: 'migCtxMod',
      key: 'migCtxEnabled',
      title: 'Migrate Context Mod',
      help: 'Test',
      options: [
        { key: 'migOpt', type: 'number', def: 10, min: 1, max: 100, title: 'Opt', help: 'Opt' }
      ],
      migrate(m) {
        capturedM = m;
        expect(m.id).toBe('migCtxMod');
        expect(m.settings.has('migOpt')).toBe(false);
        expect(m.settings.get('migOpt')).toBe(10);
        m.settings.set('migOpt', 42);
        expect(m.settings.has('migOpt')).toBe(true);

        const old = m.legacy.get('legacy_old_key', null);
        if (old) {
          m.storage.set('migrated', old);
          m.legacy.del('legacy_old_key');
        }
      },
      setup: () => {}
    });

    registry.runMigrations();

    expect(helpers.store.get('ala_mod_migCtxMod_migrated', null)).toBe('from-old');
    expect(helpers.store.get('legacy_old_key', null)).toBeNull();
    expect(helpers.store.get('ala_setting_migOpt', null)).toBe(42);

    capturedM.storage.set('migrated', 'clobbered');
    capturedM.storage.clear();
    capturedM.legacy.set('legacy_old_key', 'recreated');
    capturedM.settings.set('migOpt', 99);
    expect(helpers.store.get('ala_mod_migCtxMod_migrated', null)).toBe('from-old');
    expect(helpers.store.get('legacy_old_key', null)).toBeNull();
    expect(helpers.store.get('ala_setting_migOpt', null)).toBe(42);
  });

  it('B1-08: isolates async rejections and sync throws in runAccountAuthCallbacks() so remaining providers still run', async () => {
    const { accounts } = await loadFreshKernel();
    const calls: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      accounts.registerAccountProvider({
        id: 'prov1',
        name: 'Provider 1',
        secretKeys: [],
        isConnected: () => false,
        connect: () => {},
        disconnect: () => {},
        onAuthCallback: async () => {
          calls.push('prov1');
          await Promise.resolve();
          throw new Error('async auth failure');
        }
      });

      accounts.registerAccountProvider({
        id: 'prov2',
        name: 'Provider 2',
        secretKeys: [],
        isConnected: () => false,
        connect: () => {},
        disconnect: () => {},
        onAuthCallback: () => {
          calls.push('prov2');
          throw new Error('sync auth failure');
        }
      });

      accounts.registerAccountProvider({
        id: 'prov3',
        name: 'Provider 3',
        secretKeys: [],
        isConnected: () => false,
        connect: () => {},
        disconnect: () => {},
        onAuthCallback: async () => {
          calls.push('prov3');
        }
      });

      await expect(accounts.runAccountAuthCallbacks()).resolves.toBeUndefined();
      expect(calls).toEqual(['prov1', 'prov2', 'prov3']);
      expect(errSpy).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
    }
  });
});
