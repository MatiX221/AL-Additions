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
    let manualUnmount!: any;
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

      expect(document.getElementById('ala-routeMountMod-stale-route-widget')).toBeNull();
      expect(mountedLog).toEqual([]);
      expect(readySpy).not.toHaveBeenCalled();
      expect(navSpy).not.toHaveBeenCalled();
      expect(bodySpy).not.toHaveBeenCalled();
      expect(ownUiSpy).not.toHaveBeenCalled();

      history.pushState({}, '', '/manga/55');
      expect(typeof manualUnmount?.unmount).toBe('function');
      expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(document.getElementById('ala-routeMountMod-manual-route-widget')).not.toBeNull();
      manualUnmount.unmount();
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(document.getElementById('ala-routeMountMod-manual-route-widget')).toBeNull();
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
        accounts: ['mal'],
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
      expect(document.getElementById('ala-ctxReloadMod-stale-style-id-style')).toBeNull();
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
      expect((ctx1.api as any).session).toBeUndefined();
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

  it('auto-prefixes mount and addStyle IDs with ala- (idempotently) and enforces declared accounts at compile time and runtime', async () => {
    const { registry, settings, accounts, helpers } = await loadFreshKernel();
    const styles = await import('../src/core/styles');

    const disposeA = styles.addStyle('shared-box', '.x{color:red}');
    const disposeB = styles.addStyle('ala-shared-box', '.x{color:blue}');
    expect(document.getElementById('ala-shared-box')).not.toBeNull();
    expect(document.getElementById('shared-box')).toBeNull();
    disposeA();
    expect(document.getElementById('ala-shared-box')).not.toBeNull();
    disposeB();
    expect(document.getElementById('ala-shared-box')).toBeNull();

    accounts.registerAccountProvider({
      id: 'mal',
      name: 'MAL',
      secretKeys: ['mal_tok'],
      isConnected: () => !!helpers.store.get('mal_tok', null),
      connect: () => {},
      disconnect: () => helpers.store.del('mal_tok')
    });
    helpers.store.set('mal_tok', 'secret');

    let noAccCtx!: any;
    let malAccCtx!: any;
    document.body.innerHTML = '<div id="host-spot"></div>';

    registry.defineModule({
      id: 'noAccMod',
      key: 'noAccEnabled',
      title: 'No Accounts',
      help: 'Test',
      setup(ctx) {
        noAccCtx = ctx;
        ctx.mount({
          id: 'ala-already-prefixed',
          anchor: '#host-spot',
          create: () => document.createElement('div')
        });
        if (false as boolean) {
          // @ts-expect-error undeclared account provider blocked at compile time
          ctx.accounts.isConnected('mal');
        }
      }
    });

    registry.defineModule({
      id: 'malAccMod',
      key: 'malAccEnabled',
      accounts: ['mal'],
      title: 'MAL Accounts',
      help: 'Test',
      setup(ctx) {
        malAccCtx = ctx;
        expect(ctx.accounts.isConnected('mal')).toBe(true);
        if (false as boolean) {
          // @ts-expect-error undeclared provider blocked at compile time
          ctx.accounts.isConnected('other');
        }
      }
    });

    settings.Settings.set('noAccEnabled', true);
    settings.Settings.set('malAccEnabled', true);
    registry.startModules(false);

    expect(document.getElementById('ala-already-prefixed')).not.toBeNull();
    expect(document.getElementById('ala-ala-already-prefixed')).toBeNull();
    expect(() => noAccCtx.accounts.isConnected('mal')).toThrow(/without declaring it in accounts/);
    expect(() => noAccCtx.accounts.watch('mal', () => {})).toThrow(/without declaring it in accounts/);
    noAccCtx.accounts.clearSecrets();
    expect(helpers.store.get('mal_tok', null)).toBe('secret');
    expect(() => malAccCtx.accounts.get('other')).toThrow(/without declaring it in accounts/);
  });
});

describe('Batch 2 Registry Regression Tests', () => {
  it('BUG-04: cancels pending ctx.persistent timers on disposal and ctx.storage.clear() and supports debounce cancel/flush', async () => {
    vi.useFakeTimers();
    try {
      const { registry, settings, helpers } = await loadFreshKernel();
      const host = registry.createModuleHost();

      const fn = vi.fn();
      const d = helpers.debounce(fn, 100);
      d('first');
      d.cancel();
      vi.advanceTimersByTime(200);
      expect(fn).not.toHaveBeenCalled();

      d('flushed');
      d.flush();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('flushed');
      vi.advanceTimersByTime(200);
      expect(fn).toHaveBeenCalledTimes(1);

      let p1!: { data: Record<string, any>; save: () => void; cancel?: () => void; flush?: () => void };
      let ctx1!: any;
      registry.defineModule({
        id: 'persistMod',
        key: 'persistModEnabled',
        title: 'Persist Mod',
        help: 'Test',
        setup(ctx) {
          ctx1 = ctx;
          p1 = ctx.persistent('cache_v1') as any;
        }
      });

      settings.Settings.set('persistModEnabled', true);
      registry.startModules(false);

      p1.data.stale = 1;
      p1.save();
      settings.Settings.set('persistModEnabled', false);
      host.reload(['persistMod']);

      vi.advanceTimersByTime(600);
      expect(helpers.jsonGet('ala_mod_persistMod_cache_v1', null)).toBeNull();

      p1.data.afterDispose = 2;
      p1.save();
      p1.flush?.();
      vi.advanceTimersByTime(600);
      expect(helpers.jsonGet('ala_mod_persistMod_cache_v1', null)).toBeNull();

      settings.Settings.set('persistModEnabled', true);
      host.reload(['persistMod']);
      p1.data.beforeClear = 3;
      p1.save();
      ctx1.storage.clear();
      vi.advanceTimersByTime(600);
      expect(helpers.jsonGet('ala_mod_persistMod_cache_v1', null)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('BUG-05: runs cleanups registered during teardown and blocks live resource registrations during teardown', async () => {
    vi.useFakeTimers();
    try {
      const { registry, settings } = await loadFreshKernel();
      const log: string[] = [];
      const lateTimeout = vi.fn();
      const lateListener = vi.fn();
      const lateMountCreate = vi.fn(() => document.createElement('div'));
      const lateEl = document.createElement('span');
      document.body.innerHTML = '<div id="teardown-anchor"></div>';
      document.body.appendChild(lateEl);

      registry.defineModule({
        id: 'teardownOrderMod',
        key: 'teardownOrderEnabled',
        title: 'Teardown Order',
        help: 'Test',
        setup(ctx) {
          ctx.onCleanup(() => {
            log.push('outer-cleanup');
            ctx.onCleanup(() => log.push('inner-cleanup-1'));
            ctx.onCleanup(() => {
              log.push('inner-cleanup-2');
              ctx.onCleanup(() => log.push('nested-cleanup-3'));
            });
            ctx.trackEl(lateEl);
            ctx.timeout(lateTimeout, 10);
            ctx.listen(window, 'click', lateListener);
            ctx.mount({
              id: 'teardown-mount',
              anchor: '#teardown-anchor',
              create: lateMountCreate
            });
          });
        }
      });

      settings.Settings.set('teardownOrderEnabled', true);
      registry.startModules(false);
      registry.disposeFeature('teardownOrderMod');

      expect(log).toEqual(['outer-cleanup', 'inner-cleanup-1', 'inner-cleanup-2', 'nested-cleanup-3']);
      expect(lateEl.isConnected).toBe(false);
      expect(lateMountCreate).not.toHaveBeenCalled();

      window.dispatchEvent(new Event('click'));
      vi.advanceTimersByTime(100);
      expect(lateTimeout).not.toHaveBeenCalled();
      expect(lateListener).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('BUG-06: rolls back partial rc.* resources on sync throw and active async rejection in ctx.onRoute', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { registry, settings } = await loadFreshKernel();
      document.body.innerHTML = '<div id="route-err-anchor"></div>';

      const syncIntervalSpy = vi.fn();
      const syncClickSpy = vi.fn();
      const syncCleanupSpy = vi.fn();
      let syncRc!: any;

      const asyncIntervalSpy = vi.fn();
      const asyncCleanupSpy = vi.fn();
      let asyncRc!: any;
      let rejectAsync!: (err: Error) => void;
      let rejectSuperseded!: (err: Error) => void;
      let supersededAttempt = 0;

      history.replaceState({}, '', '/anime/10');
      registry.defineModule({
        id: 'routeRollbackMod',
        key: 'routeRollbackEnabled',
        title: 'Route Rollback',
        help: 'Test',
        setup(ctx) {
          ctx.onRoute(/^\/anime\/(\d+)/, (rc) => {
            syncRc = rc;
            rc.mount({
              id: 'sync-err-widget',
              anchor: '#route-err-anchor',
              create: () => document.createElement('div')
            });
            rc.interval(syncIntervalSpy, 50);
            rc.listen(document, 'click', syncClickSpy);
            rc.addStyle('sync-err', '.sync-err{color:red}');
            rc.onCleanup(syncCleanupSpy);
            throw new Error('sync route boom');
          });

          ctx.onRoute(/^\/manga\/(\d+)/, async (rc) => {
            asyncRc = rc;
            rc.mount({
              id: 'async-err-widget',
              anchor: '#route-err-anchor',
              create: () => document.createElement('div')
            });
            rc.interval(asyncIntervalSpy, 50);
            rc.onCleanup(asyncCleanupSpy);
            await new Promise<void>((_res, rej) => {
              rejectAsync = rej;
            });
          });

          ctx.onRoute(/^\/staff\/(\d+)/, async (rc) => {
            const attempt = ++supersededAttempt;
            if (attempt === 1) {
              await new Promise<void>((_res, rej) => {
                rejectSuperseded = rej;
              });
            } else {
              rc.mount({
                id: 'staff-new-widget',
                anchor: '#route-err-anchor',
                create: () => document.createElement('div')
              });
            }
          });
        }
      });

      settings.Settings.set('routeRollbackEnabled', true);
      registry.startModules(false);

      expect(syncRc.signal.aborted).toBe(true);
      expect(syncCleanupSpy).toHaveBeenCalledTimes(1);
      expect(document.getElementById('ala-routeRollbackMod-sync-err-widget')).toBeNull();
      expect(document.getElementById('ala-routeRollbackMod-sync-err-style')).toBeNull();
      document.dispatchEvent(new Event('click'));
      vi.advanceTimersByTime(200);
      expect(syncClickSpy).not.toHaveBeenCalled();
      expect(syncIntervalSpy).not.toHaveBeenCalled();

      history.pushState({}, '', '/manga/20');
      expect(asyncRc.signal.aborted).toBe(false);
      expect(document.getElementById('ala-routeRollbackMod-async-err-widget')).not.toBeNull();

      rejectAsync(new Error('async route boom'));
      await Promise.resolve();
      await Promise.resolve();

      expect(asyncRc.signal.aborted).toBe(true);
      expect(asyncCleanupSpy).toHaveBeenCalledTimes(1);
      expect(document.getElementById('ala-routeRollbackMod-async-err-widget')).toBeNull();
      vi.advanceTimersByTime(200);
      expect(asyncIntervalSpy).not.toHaveBeenCalled();

      history.pushState({}, '', '/staff/1');
      history.pushState({}, '', '/staff/2');
      expect(document.getElementById('ala-routeRollbackMod-staff-new-widget')).not.toBeNull();
      rejectSuperseded(new Error('superseded boom'));
      await Promise.resolve();
      await Promise.resolve();
      expect(document.getElementById('ala-routeRollbackMod-staff-new-widget')).not.toBeNull();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
      history.replaceState({}, '', '/');
    }
  });

  it('BUG-07: prunes completed timeout, cancelled listen/mount/style, and closed modal cleanups from Sets', async () => {
    vi.useFakeTimers();
    try {
      const { registry, settings } = await loadFreshKernel();
      document.body.innerHTML = '<div id="prune-anchor"></div>';
      let modCtx!: any;

      registry.defineModule({
        id: 'pruneMod',
        key: 'pruneModEnabled',
        title: 'Prune Mod',
        help: 'Test',
        setup(ctx) {
          modCtx = ctx;
        }
      });

      settings.Settings.set('pruneModEnabled', true);
      registry.startModules(false);

      const timerSpy = vi.fn();
      for (let i = 0; i < 15; i++) {
        modCtx.timeout(timerSpy, 10);
      }
      vi.advanceTimersByTime(20);
      expect(timerSpy).toHaveBeenCalledTimes(15);

      const listenerSpy = vi.fn();
      const unlisten = modCtx.listen(document, 'custom-ev', listenerSpy);
      const unstyle = modCtx.addStyle('temp', '.temp{color:red}');
      const mount = modCtx.mount({
        id: 'temp-mount',
        anchor: '#prune-anchor',
        create: () => document.createElement('div')
      });

      unlisten();
      unstyle();
      mount.unmount();

      const modalCloseSpy = vi.fn();
      const modal1 = modCtx.modal({ id: 'm1', title: 'M1', onClose: modalCloseSpy });
      modal1.close();
      expect(modalCloseSpy).toHaveBeenCalledTimes(1);

      const modal2 = modCtx.modal({ id: 'm2', title: 'M2', onClose: modalCloseSpy });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(modalCloseSpy).toHaveBeenCalledTimes(2);

      const removeListenerSpy = vi.spyOn(document, 'removeEventListener');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      removeListenerSpy.mockClear();
      clearTimeoutSpy.mockClear();

      registry.disposeFeature('pruneMod');
      expect(clearTimeoutSpy).not.toHaveBeenCalled();
      expect(removeListenerSpy.mock.calls.filter((c) => c[0] === 'custom-ev')).toHaveLength(0);
      expect(modalCloseSpy).toHaveBeenCalledTimes(2);
      modal2.close();
      expect(modalCloseSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('BUG-08: handles responseType json in ctx.http.json and aborts ctx.http requests via opts.signal without forwarding signal', async () => {
    const { registry, settings } = await loadFreshKernel();
    let httpCtx!: any;

    registry.defineModule({
      id: 'httpSigMod',
      key: 'httpSigEnabled',
      title: 'HTTP Signal',
      help: 'Test',
      setup(ctx) {
        httpCtx = ctx;
      }
    });
    settings.Settings.set('httpSigEnabled', true);
    registry.startModules(false);

    const xhrSpy = vi.spyOn(globalThis, 'GM_xmlhttpRequest');
    xhrSpy.mockImplementationOnce((details: any) => {
      details.onload?.({ status: 200, response: { ok: true, items: [1, 2] }, responseText: '' });
      return { abort: vi.fn() } as any;
    });
    await expect(httpCtx.http.json('https://example.com/data', { responseType: 'json' })).resolves.toEqual({
      ok: true,
      items: [1, 2]
    });

    const preAborted = new AbortController();
    preAborted.abort();
    xhrSpy.mockClear();
    await expect(httpCtx.http.request('https://example.com/pre', { signal: preAborted.signal })).rejects.toThrow(
      'Request aborted'
    );
    expect(xhrSpy).not.toHaveBeenCalled();

    const midController = new AbortController();
    const addAbortSpy = vi.spyOn(midController.signal, 'addEventListener');
    const removeAbortSpy = vi.spyOn(midController.signal, 'removeEventListener');
    const protoRemoveSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    const xhrAbort = vi.fn();
    xhrSpy.mockImplementationOnce((details: any) => {
      expect(details.signal).toBeUndefined();
      return { abort: xhrAbort } as any;
    });

    const pending = httpCtx.http.text('https://example.com/mid', { signal: midController.signal });
    midController.abort();
    await expect(pending).rejects.toThrow('Request aborted');
    expect(xhrAbort).toHaveBeenCalledTimes(1);
    expect(removeAbortSpy).toHaveBeenCalledTimes(addAbortSpy.mock.calls.length);
    expect(protoRemoveSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('BUG-09: injects style and registers ownUi on adopted mounts, guards detached sibling anchors, and returns null from el() after unmount', async () => {
    const { registry, settings, observer } = await loadFreshKernel();
    let mountCtx!: any;

    registry.defineModule({
      id: 'mountEdgeMod',
      key: 'mountEdgeEnabled',
      title: 'Mount Edge',
      help: 'Test',
      setup(ctx) {
        mountCtx = ctx;
      }
    });
    settings.Settings.set('mountEdgeEnabled', true);
    registry.startModules(false);

    const preExisting = document.createElement('div');
    preExisting.id = 'ala-mountEdgeMod-adopted';
    document.body.appendChild(preExisting);

    const ownUiSpy = vi.spyOn(observer.Core, 'registerOwnUi');
    const adoptedHandle = mountCtx.mount({
      id: 'adopted',
      anchor: () => document.body,
      ownUi: true,
      style: (sel: string) => `${sel} { color: purple; }`,
      create: () => document.createElement('div')
    });

    expect(adoptedHandle.el()).toBe(preExisting);
    expect(document.getElementById('ala-mountEdgeMod-adopted-style')?.textContent).toBe(
      '#ala-mountEdgeMod-adopted { color: purple; }'
    );
    expect(ownUiSpy).toHaveBeenCalledWith('#ala-mountEdgeMod-adopted');

    adoptedHandle.unmount();
    expect(adoptedHandle.el()).toBeNull();
    expect(document.getElementById('ala-mountEdgeMod-adopted-style')).toBeNull();

    const detachedAnchor = document.createElement('div');
    const detachedCreate = vi.fn(() => document.createElement('div'));
    expect(() =>
      mountCtx.mount({
        id: 'detached-sib',
        anchor: () => detachedAnchor,
        position: 'beforebegin',
        create: detachedCreate
      })
    ).not.toThrow();
    expect(detachedCreate).not.toHaveBeenCalled();
  });

  it('BUG-10: guards ctx.set, toast, silently, accounts.clearSecrets, api mutations, and disposed hasAuth pure reads', async () => {
    const { registry, settings, helpers, accounts, observer, bus, anilist } = await loadFreshKernel();
    const host = registry.createModuleHost();

    accounts.registerAccountProvider({
      id: 'mal',
      name: 'MAL',
      secretKeys: ['mal_token'],
      isConnected: () => !!helpers.store.get('mal_token', null),
      connect: () => {},
      disconnect: () => {}
    });
    helpers.store.set('mal_token', 'keep-secret');

    let modCtx!: any;
    registry.defineModule({
      id: 'dispGuardMod',
      key: 'dispGuardEnabled',
      accounts: ['mal'],
      title: 'Disposal Guard',
      help: 'Test',
      options: [{ key: 'dispOpt', type: 'number', def: 10, min: 0, max: 100, title: 'Opt', help: 'Help' }],
      setup(ctx) {
        modCtx = ctx;
      }
    });

    settings.Settings.set('dispGuardEnabled', true);
    registry.startModules(false);

    settings.Settings.set('dispGuardEnabled', false);
    host.reload(['dispGuardMod']);

    modCtx.set('dispOpt', 99);
    expect(settings.Settings.get('dispOpt')).toBe(10);

    const silentSpy = vi.spyOn(observer.Core, 'silently');
    const innerSilent = vi.fn();
    modCtx.silently(innerSilent);
    expect(silentSpy).not.toHaveBeenCalled();
    expect(innerSilent).not.toHaveBeenCalled();

    const winCloseSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    modCtx.toast.show('disposed toast', { closeTab: true });
    modCtx.toast.success('disposed success');
    modCtx.toast.error('disposed error');
    expect(document.body.textContent).not.toContain('disposed toast');
    expect(winCloseSpy).not.toHaveBeenCalled();

    modCtx.accounts.clearSecrets('mal');
    modCtx.accounts.clearSecrets();
    expect(helpers.store.get('mal_token', null)).toBe('keep-secret');

    helpers.store.set('al_token_auth', 'Bearer valid-tok');
    helpers.store.set('al_user_id', 555);
    helpers.store.set('al_username', 'Alice');
    const clearViewerSpy = vi.spyOn(anilist.anilistApiClient, 'clearViewer');
    const invSpy = vi.spyOn(anilist.anilistApiClient, 'invalidate');
    const invListSpy = vi.spyOn(anilist.anilistApiClient, 'invalidateMediaList');

    modCtx.api.clearViewer();
    modCtx.api.invalidate('Media:1');
    modCtx.api.invalidateMediaList('Alice', 'ANIME');
    expect(clearViewerSpy).not.toHaveBeenCalled();
    expect(invSpy).not.toHaveBeenCalled();
    expect(invListSpy).not.toHaveBeenCalled();
    expect(helpers.store.get('al_user_id', null)).toBe(555);

    await expect(modCtx.api.media.save(1, 'ANIME', { score: 8 })).rejects.toThrow(/disposed/i);
    await expect(modCtx.api.query('mutation { SaveMediaListEntry(mediaId: 1) { id } }')).rejects.toThrow(/disposed/i);

    document.body.innerHTML = '<nav><a href="/login">Login</a></nav>';
    expect(modCtx.session.hasAuth()).toBe(false);
    expect(modCtx.api.hasAuth()).toBe(false);
    expect(helpers.store.get('al_user_id', null)).toBe(555);
    expect(bus.CoreHooks.getAuthHeader()).toBe('Bearer valid-tok');
  });

  it('BUG-15 & BUG-37 & BUG-85: enforces unbooted status accuracy, reserved IDs, and trimmed empty modal IDs', async () => {
    const { registry, settings } = await loadFreshKernel();
    const host = registry.createModuleHost();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      registry.defineModule({
        id: 'core',
        key: 'coreConflictEnabled',
        title: 'Fake Core',
        help: 'Should reject',
        debug: { title: 'Fake Core Debug', help: 'Should not clobber' },
        setup: () => {}
      });
      registry.defineModule({
        id: 'devMode',
        key: 'devModeConflictEnabled',
        title: 'Fake DevMode',
        help: 'Should reject',
        setup: () => {}
      });
      registry.registerShellModule('core', () => {});

      expect(host.getStatus('core')).toEqual({ active: false, reason: 'invalid-id' });
      expect(host.getStatus('devMode')).toEqual({ active: false, reason: 'invalid-id' });
      expect(settings.ROWS.coreConflictEnabled).toBeUndefined();
      expect(settings.ROWS.devModeConflictEnabled).toBeUndefined();
      expect(settings.Settings.get('debug').core.channels.anilist).toBe(true);
    } finally {
      errSpy.mockRestore();
    }

    let standaloneFound = true;
    let modCtx!: any;
    registry.defineModule({
      id: 'earlyMod',
      key: 'earlyModEnabled',
      layer: 'preload',
      title: 'Early',
      help: 'Early',
      setup: () => {}
    });
    registry.defineModule({
      id: 'deferredMod',
      key: 'deferredModEnabled',
      layer: 'feature',
      requiresReload: true,
      title: 'Deferred',
      help: 'Deferred',
      standalone: { name: 'Standalone', probe: () => standaloneFound },
      setup(ctx) {
        modCtx = ctx;
      }
    });

    settings.Settings.set('earlyModEnabled', true);
    settings.Settings.set('deferredModEnabled', true);

    registry.startModules(true);
    expect(host.getStatus('earlyMod')).toEqual({ active: true });
    expect(host.getStatus('deferredMod')).toEqual({ active: false });

    await host.probeStandalone('deferredMod');
    expect(host.getStatus('deferredMod')).toEqual({ active: false, reason: 'standalone-paused' });

    standaloneFound = false;
    await host.probeStandalone('deferredMod');
    expect(host.getStatus('deferredMod')).toEqual({ active: false });
    expect(modCtx).toBeUndefined();

    registry.startModules(false);
    expect(host.getStatus('deferredMod')).toEqual({ active: true });

    const mEmpty = modCtx.modal({ id: '', title: 'Empty ID' });
    const mSpaces = modCtx.modal({ id: '   ', title: 'Spaces ID' });
    expect(mEmpty.backdrop.id).toBe('ala-deferredMod-modal-1');
    expect(mSpaces.backdrop.id).toBe('ala-deferredMod-modal-2');
    mEmpty.close();
    mSpaces.close();
  });
});

describe('Batch 10 Wave 1 Kernel API Improvements (IMP-01..04, 06, 08, 09)', () => {
  it('exposes ctx.signal aborted synchronously before cleanups and fresh per boot (IMP-09)', async () => {
    const { registry, settings } = await loadFreshKernel();
    const host = registry.createModuleHost();

    let boot1Signal!: AbortSignal;
    let boot2Signal!: AbortSignal;
    let abortedDuringCleanup = false;
    let boot = 0;

    registry.defineModule({
      id: 'sigMod',
      key: 'sigModEnabled',
      title: 'Signal Mod',
      help: 'Test',
      setup(ctx) {
        boot++;
        if (boot === 1) {
          boot1Signal = ctx.signal;
          ctx.onCleanup(() => {
            abortedDuringCleanup = ctx.signal.aborted;
          });
        } else {
          boot2Signal = ctx.signal;
        }
      }
    });

    settings.Settings.set('sigModEnabled', true);
    registry.startModules(false);
    expect(boot1Signal.aborted).toBe(false);

    host.reload(['sigMod']);
    expect(abortedDuringCleanup).toBe(true);
    expect(boot1Signal.aborted).toBe(true);
    expect(boot2Signal).not.toBe(boot1Signal);
    expect(boot2Signal.aborted).toBe(false);

    settings.Settings.set('sigModEnabled', false);
    host.reload(['sigMod']);
    expect(boot2Signal.aborted).toBe(true);
  });

  it('provides rc.modal, rc.ready, rc.onBodyMutation, and rc.http with route-exit abort and signal composition (IMP-01 & IMP-03)', async () => {
    vi.useFakeTimers();
    try {
      const { registry, settings } = await loadFreshKernel();
      document.body.innerHTML = '<div id="rc-root"></div>';

      const readyCalls: string[] = [];
      const mutCalls: number[] = [];
      let activeRc!: any;
      let routeModalCloseCalls = 0;
      let staleRc!: any;

      history.replaceState({}, '', '/anime/77');
      registry.defineModule({
        id: 'routeErgonomics',
        key: 'routeErgonomicsEnabled',
        title: 'Route Ergonomics',
        help: 'Test',
        setup(ctx) {
          ctx.onRoute(/^\/anime\/(\d+)/, (rc) => {
            activeRc = rc;
            staleRc = rc;
            rc.ready(() => readyCalls.push('immediate'));
            rc.onBodyMutation((muts) => mutCalls.push(muts.length));
            rc.modal({
              id: 'route-dialog',
              title: 'Route Modal',
              style: (sel) => `${sel} { border: 1px solid red; }`,
              onClose: () => {
                routeModalCloseCalls++;
              }
            });
          });
        }
      });

      settings.Settings.set('routeErgonomicsEnabled', true);
      registry.startModules(false);

      expect(readyCalls).toEqual(['immediate']);
      expect(document.getElementById('ala-routeErgonomics-route-dialog')).not.toBeNull();
      expect(document.getElementById('ala-routeErgonomics-route-dialog-style')).not.toBeNull();

      document.getElementById('rc-root')!.appendChild(document.createElement('span'));
      await Promise.resolve();
      vi.advanceTimersByTime(60);
      expect(mutCalls.length).toBe(1);

      const xhrAbort = vi.fn();
      const xhrSpy = vi.spyOn(globalThis, 'GM_xmlhttpRequest').mockImplementation((details: any) => {
        expect(details.signal).toBeUndefined();
        return { abort: xhrAbort } as any;
      });
      const dlAbort = vi.fn();
      const dlSpy = vi.spyOn(globalThis, 'GM_download').mockImplementation(() => ({ abort: dlAbort }) as any);

      const callerAc = new AbortController();
      const callerReq = activeRc.http.text('https://example.com/caller-abort', { signal: callerAc.signal });
      callerAc.abort();
      await expect(callerReq).rejects.toThrow('Request aborted');
      expect(xhrAbort).toHaveBeenCalledTimes(1);
      expect(activeRc.signal.aborted).toBe(false);

      xhrAbort.mockClear();
      const routeTextReq = activeRc.http.json('https://example.com/route-abort');
      const routeDlReq = activeRc.http.download('https://example.com/file.bin', 'file.bin');

      history.pushState({}, '', '/home');

      await expect(routeTextReq).rejects.toThrow('Request aborted');
      await expect(routeDlReq).rejects.toThrow('Download aborted');
      expect(xhrAbort).toHaveBeenCalledTimes(1);
      expect(dlAbort).toHaveBeenCalledTimes(1);
      expect(routeModalCloseCalls).toBe(1);
      expect(document.getElementById('ala-routeErgonomics-route-dialog')).toBeNull();
      expect(document.getElementById('ala-routeErgonomics-route-dialog-style')).toBeNull();

      document.getElementById('rc-root')!.appendChild(document.createElement('b'));
      await Promise.resolve();
      vi.advanceTimersByTime(60);
      expect(mutCalls.length).toBe(1);

      xhrSpy.mockClear();
      dlSpy.mockClear();
      await expect(staleRc.http.request('https://example.com/after-exit')).rejects.toThrow('Request aborted');
      await expect(staleRc.http.download('https://example.com/after.bin', 'after.bin')).rejects.toThrow(
        'Download aborted'
      );
      expect(xhrSpy).not.toHaveBeenCalled();
      expect(dlSpy).not.toHaveBeenCalled();

      const deadRouteModal = staleRc.modal({ id: 'dead-route', title: 'Dead' });
      expect(deadRouteModal.signal.aborted).toBe(true);
      expect(document.getElementById('ala-routeErgonomics-dead-route')).toBeNull();
    } finally {
      vi.useRealTimers();
      history.replaceState({}, '', '/');
    }
  });

  it('implements lifecycle-tracked debounce, raf, and { once: true } listen self-pruning on ctx and rc (IMP-04)', async () => {
    vi.useFakeTimers();
    try {
      const { registry, settings } = await loadFreshKernel();
      let modCtx!: any;
      let routeRc!: any;

      history.replaceState({}, '', '/anime/11');
      registry.defineModule({
        id: 'timingMod',
        key: 'timingModEnabled',
        title: 'Timing Mod',
        help: 'Test',
        setup(ctx) {
          modCtx = ctx;
          ctx.onRoute(/^\/anime\/\d+/, (rc) => {
            routeRc = rc;
          });
        }
      });

      settings.Settings.set('timingModEnabled', true);
      registry.startModules(false);

      const debouncedSpy = vi.fn();
      const d = routeRc.debounce(debouncedSpy, 100);
      d('a');
      d('b');
      vi.advanceTimersByTime(100);
      expect(debouncedSpy).toHaveBeenCalledTimes(1);
      expect(debouncedSpy).toHaveBeenCalledWith('b');

      d('flushed');
      d.flush();
      expect(debouncedSpy).toHaveBeenCalledTimes(2);
      expect(debouncedSpy).toHaveBeenLastCalledWith('flushed');

      d('cancelled-by-route');
      const rafSpy = vi.fn();
      routeRc.raf(rafSpy);

      const onceTarget = document.createElement('div');
      const onceListener = vi.fn();
      modCtx.listen(onceTarget, 'my-once', onceListener, { once: true });
      onceTarget.dispatchEvent(new Event('my-once'));
      onceTarget.dispatchEvent(new Event('my-once'));
      expect(onceListener).toHaveBeenCalledTimes(1);

      history.pushState({}, '', '/home');
      d.flush();
      vi.advanceTimersByTime(200);
      expect(debouncedSpy).toHaveBeenCalledTimes(2);
      expect(rafSpy).not.toHaveBeenCalled();

      const ctxDebouncedSpy = vi.fn();
      const ctxD = modCtx.debounce(ctxDebouncedSpy, 100);
      ctxD('pending');
      const ctxRafSpy = vi.fn();
      modCtx.raf(ctxRafSpy);

      const removeSpy = vi.spyOn(onceTarget, 'removeEventListener');
      registry.disposeFeature('timingMod');
      expect(removeSpy.mock.calls.filter((c) => c[0] === 'my-once')).toHaveLength(0);

      ctxD('post-dispose');
      ctxD.flush();
      vi.advanceTimersByTime(200);
      expect(ctxDebouncedSpy).not.toHaveBeenCalled();
      expect(ctxRafSpy).not.toHaveBeenCalled();

      const origRaf = globalThis.requestAnimationFrame;
      try {
        (globalThis as any).requestAnimationFrame = undefined;
        settings.Settings.set('timingModEnabled', true);
        registry.createModuleHost().reload(['timingMod']);
        const fallbackRafSpy = vi.fn();
        modCtx.raf(fallbackRafSpy);
        vi.advanceTimersByTime(20);
        expect(fallbackRafSpy).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.requestAnimationFrame = origRaf;
      }
    } finally {
      vi.useRealTimers();
      history.replaceState({}, '', '/');
    }
  });

  it('supports MountSpec<T> onMount cleanup across detach/match/unmount and MountHandle.refresh() (IMP-06)', async () => {
    vi.useFakeTimers();
    try {
      const { registry, settings } = await loadFreshKernel();
      document.body.innerHTML = '<div id="mount-imp06-anchor"></div>';

      let enabled = false;
      const mountCalls: string[] = [];
      const cleanupCalls: string[] = [];
      let seq = 0;
      let handle!: any;

      registry.defineModule({
        id: 'mountHookMod',
        key: 'mountHookEnabled',
        title: 'Mount Hook',
        help: 'Test',
        setup(ctx) {
          handle = ctx.mount<HTMLAnchorElement>({
            id: 'typed-link',
            anchor: '#mount-imp06-anchor',
            match: () => enabled,
            create: () => {
              const a = document.createElement('a');
              a.dataset.seq = String(++seq);
              return a;
            },
            onMount: (el) => {
              const id = el.dataset.seq!;
              mountCalls.push(`mount:${id}`);
              return () => {
                cleanupCalls.push(`cleanup:${id}`);
              };
            }
          });
        }
      });

      settings.Settings.set('mountHookEnabled', true);
      registry.startModules(false);

      expect(handle.el()).toBeNull();
      expect(mountCalls).toEqual([]);

      enabled = true;
      handle.refresh();
      expect(handle.el()?.tagName).toBe('A');
      expect(mountCalls).toEqual(['mount:1']);
      expect(cleanupCalls).toEqual([]);

      handle.refresh();
      expect(mountCalls).toEqual(['mount:1']);

      handle.el()!.remove();
      document.body.appendChild(document.createElement('span'));
      await Promise.resolve();
      vi.advanceTimersByTime(60);
      expect(cleanupCalls).toEqual(['cleanup:1']);
      expect(mountCalls).toEqual(['mount:1', 'mount:2']);

      enabled = false;
      handle.refresh();
      expect(handle.el()).toBeNull();
      expect(cleanupCalls).toEqual(['cleanup:1', 'cleanup:2']);

      enabled = true;
      handle.refresh();
      expect(mountCalls).toEqual(['mount:1', 'mount:2', 'mount:3']);

      handle.unmount();
      expect(cleanupCalls).toEqual(['cleanup:1', 'cleanup:2', 'cleanup:3']);
      registry.disposeFeature('mountHookMod');
      expect(cleanupCalls).toEqual(['cleanup:1', 'cleanup:2', 'cleanup:3']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Batch 11 Wave 1 Kernel Improvements (IMP-05, IMP-10, IMP-16)', () => {
  it('propagates ctx.signal across ctx.api with waiter-isolated abort and post-disposal safety (IMP-05)', async () => {
    const { registry, settings, anilist } = await loadFreshKernel();
    const fetchMock = vi.fn();
    const origFetch = window.fetch;
    window.fetch = fetchMock as any;

    try {
      let ctxA!: any;
      let ctxB!: any;

      registry.defineModule({
        id: 'apiIsoA',
        key: 'apiIsoAEnabled',
        title: 'API Iso A',
        help: 'Test',
        setup(ctx) {
          ctxA = ctx;
        }
      });
      registry.defineModule({
        id: 'apiIsoB',
        key: 'apiIsoBEnabled',
        title: 'API Iso B',
        help: 'Test',
        setup(ctx) {
          ctxB = ctx;
        }
      });

      settings.Settings.set('apiIsoAEnabled', true);
      settings.Settings.set('apiIsoBEnabled', true);
      registry.startModules(false);

      let resolveShared!: (r: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveShared = resolve;
          })
      );

      const q = 'query ($id: Int) { Media(id: $id) { id title { romaji } } }';
      const pA = ctxA.api.query(q, { id: 777 });
      const pB = ctxB.api.query(q, { id: 777 });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      // Disposing A aborts A's waiter without aborting B's shared request
      registry.disposeFeature('apiIsoA');
      await expect(pA).rejects.toMatchObject({ name: 'AbortError' });

      resolveShared(new Response(JSON.stringify({ data: { Media: { id: 777, title: { romaji: 'Shared OK' } } } }), { status: 200 }));
      await expect(pB).resolves.toEqual({ Media: { id: 777, title: { romaji: 'Shared OK' } } });

      // Post-disposal calls on ctxA.api reject cleanly (or return null for media.get)
      await expect(ctxA.api.query(q, { id: 778 })).rejects.toMatchObject({ name: 'AbortError' });
      await expect(ctxA.api.getMediaList(1, 'ANIME')).rejects.toMatchObject({ name: 'AbortError' });
      await expect(ctxA.api.viewer()).rejects.toMatchObject({ name: 'AbortError' });
      await expect(ctxA.api.media.get(778, 'ANIME')).resolves.toBeNull();
      expect(anilist.AniList.hasAuth()).toBe(false);
    } finally {
      window.fetch = origFetch;
    }
  });

  it('auto-resolves ctx.confirm and ctx.alert cleanly on disposal and suppresses post-disposal dialogs (IMP-10)', async () => {
    const { registry, settings } = await loadFreshKernel();
    let modCtx!: any;

    registry.defineModule({
      id: 'dialogMod',
      key: 'dialogModEnabled',
      title: 'Dialog Mod',
      help: 'Test',
      setup(ctx) {
        modCtx = ctx;
      }
    });

    settings.Settings.set('dialogModEnabled', true);
    registry.startModules(false);

    const confirmPromise = modCtx.confirm({ id: 'mod-confirm', message: 'Proceed?' });
    expect(document.getElementById('ala-dialogMod-mod-confirm')).not.toBeNull();

    registry.disposeFeature('dialogMod');
    await expect(confirmPromise).resolves.toBe(false);
    expect(document.getElementById('ala-dialogMod-mod-confirm')).toBeNull();

    await expect(modCtx.confirm({ id: 'late-confirm', message: 'Late' })).resolves.toBe(false);
    await expect(modCtx.alert({ id: 'late-alert', message: 'Late' })).resolves.toBeUndefined();
    expect(document.getElementById('ala-dialogMod-late-confirm')).toBeNull();
    expect(document.getElementById('ala-dialogMod-late-alert')).toBeNull();
  });

  it('isolates per-context markFetchOwner leases via whenAlive and releases on markFetchOwner(false) or teardown (IMP-16)', async () => {
    const origWinFetch = window.fetch;
    const { registry, settings, bus, observer } = await loadFreshKernel();
    const baseFetch = vi.fn(async () => new Response(JSON.stringify({ data: { Viewer: { id: 1 } } }), { status: 200 }));
    window.fetch = baseFetch as any;

    const gqlEvents: string[] = [];
    const unsubGql = bus.CoreHooks.onGqlFetch((ev) => gqlEvents.push(ev.phase));
    try {
      let ctxA!: any;
      let ctxB!: any;

      registry.defineModule({
        id: 'ownerModA',
        key: 'ownerModAEnabled',
        title: 'Owner A',
        help: 'Test',
        setup(ctx) {
          ctxA = ctx;
        }
      });
      registry.defineModule({
        id: 'ownerModB',
        key: 'ownerModBEnabled',
        title: 'Owner B',
        help: 'Test',
        setup(ctx) {
          ctxB = ctx;
        }
      });

      settings.Settings.set('ownerModAEnabled', true);
      settings.Settings.set('ownerModBEnabled', true);
      registry.startModules(false);

      const leaseA = ctxA.hooks.markFetchOwner(true);
      ctxB.hooks.markFetchOwner(true);
      expect(typeof leaseA).toBe('function');
      expect((window as any).__alaCoreMirror?.fetchOwner).toBe(true);
      expect(window.fetch).toBe(baseFetch);

      // Module A releasing via markFetchOwner(false) keeps Module B's lease active
      ctxA.hooks.markFetchOwner(false);
      expect((window as any).__alaCoreMirror?.fetchOwner).toBe(true);
      expect(window.fetch).toBe(baseFetch);

      // Module B unloading without manual markFetchOwner(false) releases its token automatically
      registry.disposeFeature('ownerModB');
      expect((window as any).__alaCoreMirror?.fetchOwner).toBe(false);
      expect(window.fetch).not.toBe(baseFetch);

      await window.fetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query AutoReleased { Viewer { id } }' })
      });
      expect(gqlEvents).toEqual(['request', 'response']);
      expect(observer.Core).toBeDefined();
    } finally {
      unsubGql();
      window.fetch = origWinFetch;
    }
  });

  it('re-probes standalone before clearing standalonePaused on host.reload and gates deferred modules before startModules(false) when document.body is null (BUG-06)', async () => {
    const { registry, settings } = await loadFreshKernel();
    const host = registry.createModuleHost();

    let syncProbeActive = true;
    let asyncProbeActive = true;
    const bootLog: string[] = [];
    const cleanupLog: string[] = [];

    registry.defineModule({
      id: 'earlyMod',
      key: 'earlyModEnabled',
      layer: 'preload',
      title: 'Early Mod',
      help: 'Test',
      setup(ctx) {
        bootLog.push('earlyMod');
        ctx.onCleanup(() => cleanupLog.push('earlyMod'));
      }
    });

    registry.defineModule({
      id: 'deferredMod',
      key: 'deferredModEnabled',
      layer: 'feature',
      title: 'Deferred Mod',
      help: 'Test',
      setup() {
        bootLog.push('deferredMod');
      }
    });

    registry.defineModule({
      id: 'syncStandaloneMod',
      key: 'syncStandaloneEnabled',
      layer: 'service',
      title: 'Sync Standalone',
      help: 'Test',
      standalone: { name: 'Sync Standalone', probe: () => syncProbeActive },
      setup() {
        bootLog.push('syncStandaloneMod');
      }
    });

    registry.defineModule({
      id: 'syncStandaloneChild',
      key: 'syncStandaloneChildEnabled',
      layer: 'feature',
      dependsOn: ['syncStandaloneMod'],
      title: 'Sync Standalone Child',
      help: 'Test',
      setup() {
        bootLog.push('syncStandaloneChild');
      }
    });

    registry.defineModule({
      id: 'asyncStandaloneMod',
      key: 'asyncStandaloneEnabled',
      layer: 'service',
      title: 'Async Standalone',
      help: 'Test',
      standalone: { name: 'Async Standalone', probe: async () => asyncProbeActive },
      setup(ctx) {
        bootLog.push('asyncStandaloneMod');
        ctx.onCleanup(() => cleanupLog.push('asyncStandaloneMod'));
      }
    });

    registry.defineModule({
      id: 'asyncStandaloneChild',
      key: 'asyncStandaloneChildEnabled',
      layer: 'feature',
      dependsOn: ['asyncStandaloneMod'],
      title: 'Async Standalone Child',
      help: 'Test',
      setup(ctx) {
        bootLog.push('asyncStandaloneChild');
        ctx.onCleanup(() => cleanupLog.push('asyncStandaloneChild'));
      }
    });

    settings.Settings.set('earlyModEnabled', true);
    settings.Settings.set('deferredModEnabled', true);
    settings.Settings.set('syncStandaloneEnabled', true);
    settings.Settings.set('syncStandaloneChildEnabled', true);
    settings.Settings.set('asyncStandaloneEnabled', true);
    settings.Settings.set('asyncStandaloneChildEnabled', true);

    const origBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      registry.startModules(true);
      expect(bootLog).toEqual(['earlyMod']);

      host.reload(['earlyMod', 'deferredMod']);
      expect(cleanupLog).toEqual(['earlyMod']);
      expect(bootLog).toEqual(['earlyMod', 'earlyMod']);
      expect(host.getStatus('deferredMod').active).toBe(false);
    } finally {
      delete (document as any).body;
      if (!document.body && origBody) document.documentElement.appendChild(origBody);
    }

    await host.probeStandalone('syncStandaloneMod');
    expect(host.getStatus('syncStandaloneMod')).toEqual({ active: false, reason: 'standalone-paused' });

    registry.startModules(false);
    expect(bootLog).toContain('deferredMod');
    expect(bootLog).not.toContain('syncStandaloneMod');
    expect(bootLog).not.toContain('syncStandaloneChild');

    // Sync standalone probe still active -> reload keeps standalone-paused and does not boot
    host.reload(['syncStandaloneMod']);
    expect(bootLog).not.toContain('syncStandaloneMod');
    expect(bootLog).not.toContain('syncStandaloneChild');
    expect(host.getStatus('syncStandaloneMod')).toEqual({ active: false, reason: 'standalone-paused' });
    expect(host.getStatus('syncStandaloneChild')).toEqual({
      active: false,
      reason: 'dep-unavailable',
      missingDeps: ['syncStandaloneMod']
    });

    // Async standalone probe resolving true -> post-probe cascadeDispose tears down parent & child
    await host.probeStandalone('asyncStandaloneMod');
    expect(host.getStatus('asyncStandaloneMod')).toEqual({ active: false, reason: 'standalone-paused' });
    cleanupLog.length = 0;
    host.reload(['asyncStandaloneMod']);
    await Promise.resolve();
    await Promise.resolve();
    expect(cleanupLog).toEqual(['asyncStandaloneChild', 'asyncStandaloneMod']);
    expect(host.getStatus('asyncStandaloneMod')).toEqual({ active: false, reason: 'standalone-paused' });
    expect(host.getStatus('asyncStandaloneChild')).toEqual({
      active: false,
      reason: 'dep-unavailable',
      missingDeps: ['asyncStandaloneMod']
    });

    // When standalone conflict clears, reload boots parent and dependent cleanly
    syncProbeActive = false;
    host.reload(['syncStandaloneMod']);
    expect(host.getStatus('syncStandaloneMod')).toEqual({ active: true });
    expect(host.getStatus('syncStandaloneChild')).toEqual({ active: true });

    asyncProbeActive = false;
    host.reload(['asyncStandaloneMod']);
    await Promise.resolve();
    expect(host.getStatus('asyncStandaloneMod')).toEqual({ active: true });
    expect(host.getStatus('asyncStandaloneChild')).toEqual({ active: true });
  });

  it('IMP-02: scopes rc.api to route lifecycle, aborts reads/mutations on navigation, rejects post-teardown mutations, and keeps hasAuth() non-reconciling once closed', async () => {
    const origWinFetch = window.fetch;
    const { registry, settings, helpers, bus, anilist } = await loadFreshKernel();
    const host = registry.createModuleHost();

    let capturedCtx!: any;
    let capturedRc!: any;

    registry.defineModule({
      id: 'routeApiMod',
      key: 'routeApiEnabled',
      requiresReload: false,
      title: 'Route API',
      help: 'Test',
      setup(ctx) {
        capturedCtx = ctx;
        ctx.onRoute(/\/anime\/\d+/, (rc) => {
          capturedRc = rc;
        });
      }
    });

    history.replaceState({}, '', '/anime/101');
    settings.Settings.set('routeApiEnabled', true);

    try {
      registry.startModules(false);

      expect(capturedRc).toBeDefined();
      expect(capturedRc.api).toBe(capturedRc.api);
      expect((capturedRc.api as any).session).toBeUndefined();

      const makeAbortingPromise = (signal?: AbortSignal) =>
        new Promise<any>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
            { once: true }
          );
        });

      const forwardedSignals: Array<AbortSignal | undefined> = [];
      const querySpy = vi
        .spyOn(anilist.anilistApiClient, 'query')
        .mockImplementation((_q, _v, opts) => {
          const sig = typeof opts === 'object' ? opts?.signal : undefined;
          forwardedSignals.push(sig);
          return makeAbortingPromise(sig);
        });
      const viewerSpy = vi
        .spyOn(anilist.anilistApiClient, 'viewer')
        .mockImplementation((_f, opts) => {
          forwardedSignals.push(opts?.signal);
          return makeAbortingPromise(opts?.signal);
        });
      const listSpy = vi
        .spyOn(anilist.anilistApiClient, 'getMediaList')
        .mockImplementation((_t, _ty, opts) => {
          forwardedSignals.push(opts?.signal);
          return makeAbortingPromise(opts?.signal);
        });
      const mediaGetSpy = vi
        .spyOn(anilist.anilistApiClient.media, 'get')
        .mockImplementation((_id, _ty, opts) => {
          forwardedSignals.push(opts?.signal);
          return makeAbortingPromise(opts?.signal);
        });
      const mediaSaveSpy = vi
        .spyOn(anilist.anilistApiClient.media, 'save')
        .mockImplementation((_id, _ty, _patch, opts) => {
          forwardedSignals.push(opts?.signal);
          return makeAbortingPromise(opts?.signal);
        });

      const callerAc = new AbortController();
      const pCallerAborted = capturedRc.api.viewer(true, { signal: callerAc.signal });
      callerAc.abort();
      await expect(pCallerAborted).rejects.toMatchObject({ name: 'AbortError' });
      expect(capturedRc.signal.aborted).toBe(false);

      forwardedSignals.length = 0;
      const pQuery = capturedRc.api.query('query { Media(id: 101) { id } }', undefined, 2);
      const pViewer = capturedRc.api.viewer(true);
      const pList = capturedRc.api.getMediaList('Alice', 'ANIME');
      const pMediaGet = capturedRc.api.media.get(101, 'ANIME');
      const pMediaSave = capturedRc.api.media.save(101, 'ANIME', { progress: 3 });

      expect(forwardedSignals).toHaveLength(5);
      expect(forwardedSignals.every((s) => s && !s.aborted)).toBe(true);

      history.pushState({}, '', '/home');
      expect(capturedRc.signal.aborted).toBe(true);
      expect(forwardedSignals.every((s) => s?.aborted === true)).toBe(true);

      await expect(pQuery).rejects.toMatchObject({ name: 'AbortError' });
      await expect(pViewer).rejects.toMatchObject({ name: 'AbortError' });
      await expect(pList).rejects.toMatchObject({ name: 'AbortError' });
      await expect(pMediaGet).rejects.toMatchObject({ name: 'AbortError' });
      await expect(pMediaSave).rejects.toMatchObject({ name: 'AbortError' });

      // Post-teardown mutations reject immediately without reaching anilistApiClient
      querySpy.mockClear();
      mediaSaveSpy.mockClear();
      viewerSpy.mockClear();
      listSpy.mockClear();
      mediaGetSpy.mockClear();

      await expect(
        capturedRc.api.query('mutation { SaveMediaListEntry(mediaId: 1) { id } }')
      ).rejects.toThrow(/disposed/i);
      await expect(capturedRc.api.media.save(101, 'ANIME', { score: 8 })).rejects.toThrow(/disposed/i);
      expect(querySpy).not.toHaveBeenCalled();
      expect(mediaSaveSpy).not.toHaveBeenCalled();

      // Post-teardown cache/viewer invalidations are no-ops
      const clearViewerSpy = vi.spyOn(anilist.anilistApiClient, 'clearViewer');
      const invSpy = vi.spyOn(anilist.anilistApiClient, 'invalidate');
      const invListSpy = vi.spyOn(anilist.anilistApiClient, 'invalidateMediaList');
      capturedRc.api.clearViewer();
      capturedRc.api.invalidate('Media:101');
      capturedRc.api.invalidateMediaList('Alice', 'ANIME');
      expect(clearViewerSpy).not.toHaveBeenCalled();
      expect(invSpy).not.toHaveBeenCalled();
      expect(invListSpy).not.toHaveBeenCalled();

      // Closed rc.api.hasAuth() passes { reconcile: false } so stale session data is not wiped
      helpers.store.set('al_token_auth', 'Bearer valid-tok');
      helpers.store.set('al_user_id', 555);
      helpers.store.set('al_username', 'Alice');
      bus.CoreHooks.setAuthHeader('Bearer valid-tok');
      document.body.innerHTML = '<nav><a href="/login">Login</a></nav>';

      expect(capturedRc.api.hasAuth()).toBe(false);
      expect(helpers.store.get('al_user_id', null)).toBe(555);
      expect(helpers.store.get('al_username', null)).toBe('Alice');
      expect(bus.CoreHooks.getAuthHeader()).toBe('Bearer valid-tok');

      // End-to-end fetch abort check with real anilistApiClient on new route entry
      vi.restoreAllMocks();
      const fetchSignals: Array<AbortSignal | undefined> = [];
      window.fetch = vi.fn((_url, init?: RequestInit) => {
        fetchSignals.push(init?.signal ?? undefined);
        return makeAbortingPromise(init?.signal ?? undefined);
      }) as any;

      history.pushState({}, '', '/anime/202');
      const secondRc = capturedRc;
      expect(secondRc).not.toBeNull();
      expect(secondRc.signal.aborted).toBe(false);

      const liveFetchQuery = secondRc.api.query('query { Media(id: 202) { id } }', {}, { forceFresh: true });
      const liveFetchExpect = expect(liveFetchQuery).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(fetchSignals).toHaveLength(1));
      expect(fetchSignals[0]?.aborted).toBe(false);

      // Module ctx.api remains open after route exit, while secondRc.api aborts
      history.pushState({}, '', '/home');
      await liveFetchExpect;
      expect(fetchSignals[0]?.aborted).toBe(true);
      expect(capturedCtx.signal.aborted).toBe(false);

      settings.Settings.set('routeApiEnabled', false);
      host.reload(['routeApiMod']);
      expect(capturedCtx.signal.aborted).toBe(true);
      await expect(capturedCtx.api.media.save(202, 'ANIME', { score: 9 })).rejects.toThrow(/disposed/i);
    } finally {
      window.fetch = origWinFetch;
      history.replaceState({}, '', '/');
    }
  });

  it('IMP-01, IMP-03, IMP-04, IMP-09: exposes rc.getId/confirm/alert/observe, aborts ctx.http at teardown start, and flushes ctx.persistent on pagehide only while active', async () => {
    const { registry, settings, helpers } = await loadFreshKernel();
    const xhrSpy = vi.spyOn(globalThis, 'GM_xmlhttpRequest');

    let capturedCtx!: any;
    let capturedRc!: any;
    let httpAbortedBeforeCleanup = false;
    let cacheHandle!: any;
    const obsRecords: MutationRecord[][] = [];

    history.replaceState({}, '', '/anime/303');
    registry.defineModule({
      id: 'wave1KernelMod',
      key: 'wave1KernelEnabled',
      layer: 'feature',
      requiresReload: false,
      title: 'Wave 1 Kernel',
      help: 'Test',
      setup(ctx) {
        capturedCtx = ctx;
        cacheHandle = ctx.persistent<{ count: number }>('wave1Cache');
        ctx.onRoute(/^\/anime\/\d+/, (rc) => {
          capturedRc = rc;
          rc.observe(document.body, { childList: true }, (mutations) => {
            obsRecords.push(mutations);
          });
        });
      }
    });

    settings.Settings.set('wave1KernelEnabled', true);
    registry.startModules(false);

    // IMP-01: rc.getId namespacing + rc.confirm / rc.alert auto-resolve on route exit
    expect(capturedRc.getId('badge')).toBe('ala-wave1KernelMod-badge');
    expect(capturedRc.getId('ala-custom')).toBe('ala-custom');
    expect(capturedRc.getId()).toMatch(/^ala-wave1KernelMod-\d+$/);

    const confirmP = capturedRc.confirm({ id: 'route-confirm', message: 'Confirm route?' });
    expect(document.getElementById('ala-wave1KernelMod-route-confirm')).not.toBeNull();
    const alertP = capturedRc.alert({ id: 'route-alert', message: 'Alert route!' });
    expect(document.getElementById('ala-wave1KernelMod-route-alert')).not.toBeNull();

    // IMP-04: rc.observe delivers mutations while route is active
    const probeNode = document.createElement('div');
    document.body.appendChild(probeNode);
    await Promise.resolve();
    expect(obsRecords.length).toBeGreaterThanOrEqual(1);
    const countAtExit = obsRecords.length;

    // Route exit dismisses rc.confirm -> false, rc.alert -> undefined, and disconnects rc.observe
    history.pushState({}, '', '/home');
    await expect(confirmP).resolves.toBe(false);
    await expect(alertP).resolves.toBeUndefined();
    expect(document.getElementById('ala-wave1KernelMod-route-confirm')).toBeNull();
    expect(document.getElementById('ala-wave1KernelMod-route-alert')).toBeNull();

    document.body.appendChild(document.createElement('span'));
    await Promise.resolve();
    expect(obsRecords).toHaveLength(countAtExit);

    // Post-teardown rc.confirm / rc.alert resolve immediately without mounting
    await expect(capturedRc.confirm({ id: 'post-confirm', message: 'Noop' })).resolves.toBe(false);
    await expect(capturedRc.alert({ id: 'post-alert', message: 'Noop' })).resolves.toBeUndefined();
    expect(document.getElementById('ala-wave1KernelMod-post-confirm')).toBeNull();
    expect(document.getElementById('ala-wave1KernelMod-post-alert')).toBeNull();

    // IMP-09: pagehide flushes pending ctx.persistent writes while active
    vi.useFakeTimers();
    try {
      cacheHandle.data.count = 42;
      cacheHandle.save();
      expect(helpers.jsonGet('ala_mod_wave1KernelMod_wave1Cache', null)).toBeNull();
      window.dispatchEvent(new Event('pagehide'));
      expect(helpers.jsonGet('ala_mod_wave1KernelMod_wave1Cache', null)).toEqual({ count: 42 });

      // Queue another debounced write, then dispose -> pagehide must NOT flush cancelled write
      cacheHandle.data.count = 99;
      cacheHandle.save();
    } finally {
      vi.useRealTimers();
    }

    // IMP-03: ctx.http aborts at teardown start (before ctx.onCleanup runs)
    const abortFn = vi.fn();
    xhrSpy.mockImplementation(() => ({ abort: abortFn }) as any);
    let httpRejectedBeforeCleanup = false;
    const pendingHttp = capturedCtx.http.text('https://example.com/teardown-start').catch((err: Error) => {
      httpRejectedBeforeCleanup = err.message === 'Request aborted';
      throw err;
    });

    capturedCtx.onCleanup(() => {
      httpAbortedBeforeCleanup = capturedCtx.signal.aborted && abortFn.mock.calls.length === 1;
    });

    registry.disposeFeature('wave1KernelMod');
    expect(httpAbortedBeforeCleanup).toBe(true);
    await expect(pendingHttp).rejects.toThrow('Request aborted');
    expect(httpRejectedBeforeCleanup).toBe(true);

    // Post-disposal pagehide does not flush the cancelled write (count remains 42)
    window.dispatchEvent(new Event('pagehide'));
    expect(helpers.jsonGet('ala_mod_wave1KernelMod_wave1Cache', null)).toEqual({ count: 42 });
    probeNode.remove();
    history.replaceState({}, '', '/');
  });
});
