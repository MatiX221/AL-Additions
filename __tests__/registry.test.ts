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

  it('B1-07: gates ctx.debug.log() and patternless registerDebugChannel() on channel opt-in and handles /g and /y patterns', async () => {
    const { registry, settings, helpers, types } = await loadFreshKernel();
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    let noPatCtx!: any;

    registry.defineModule({
      id: 'noPatMod',
      key: 'noPatEnabled',
      title: 'No Pattern Mod',
      help: 'Test',
      debug: {
        key: 'debugNoPat',
        title: 'No Pattern Debug',
        help: 'Omits pattern'
      },
      setup(ctx) {
        noPatCtx = ctx;
      }
    });

    helpers.registerDebugChannel('', `${types.SETTING_PREFIX}debugEmpty`, false);
    helpers.registerDebugChannel('mod', `${types.SETTING_PREFIX}debugModPrefix`, false);
    helpers.registerDebugChannel('mod.v1+', `${types.SETTING_PREFIX}debugSpecialPlus`, false);
    helpers.registerDebugChannel('mod.v1+test', `${types.SETTING_PREFIX}debugSpecial`, false);
    helpers.registerDebugChannel('gMod', `${types.SETTING_PREFIX}debugGMod`, false, /^\[GMOD/gi);
    helpers.registerDebugChannel('yMod', `${types.SETTING_PREFIX}debugYMod`, false, /\[YMOD/yi);

    settings.Settings.set('noPatEnabled', true);
    registry.startModules(false);

    settings.Settings.set('devModeEnabled', true);
    settings.Settings.set('debugNoPat', false);

    expect(noPatCtx.debug.enabled()).toBe(false);
    noPatCtx.debug.log('should-suppress');
    helpers.logDebug('[NOPATMOD]', 'should-suppress');
    helpers.logDebug('[NOPATMOD] direct-suppress');
    helpers.logDebug('[MOD.V1+TEST] escaped-suppress');
    helpers.logDebug('[MOD.V1+] msg');
    helpers.logDebug('[MOD.V1+:sub]', 'sub-suppress');
    helpers.logDebug('[MOD] prefix-suppress');

    helpers.logDebug('[GMOD] call 1');
    helpers.logDebug('[GMOD] call 2');
    helpers.logDebug('[GMOD] call 3');
    helpers.logDebug('[YMOD] call 1');
    helpers.logDebug('[YMOD] call 2');
    expect(debugSpy).not.toHaveBeenCalled();

    helpers.logDebug('[UNREGISTERED]', 'visible');
    helpers.logDebug('[MODXV111TEST]', 'escaped-verify');
    helpers.logDebug('[MOD.V1+X] msg');
    helpers.logDebug('[MODXV1+] msg');
    expect(debugSpy).toHaveBeenCalledTimes(4);
    expect(debugSpy).toHaveBeenNthCalledWith(1, '[UNREGISTERED]', 'visible');
    expect(debugSpy).toHaveBeenNthCalledWith(2, '[MODXV111TEST]', 'escaped-verify');
    expect(debugSpy).toHaveBeenNthCalledWith(3, '[MOD.V1+X] msg');
    expect(debugSpy).toHaveBeenNthCalledWith(4, '[MODXV1+] msg');

    debugSpy.mockClear();
    helpers.store.set(`${types.SETTING_PREFIX}debugSpecialPlus`, true);
    helpers.logDebug('[MOD.V1+] msg');
    helpers.logDebug('[MOD.V1+:sub]', 'enabled-sub');
    helpers.logDebug('[MOD] still-suppressed');
    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy).toHaveBeenNthCalledWith(1, '[MOD.V1+] msg');
    expect(debugSpy).toHaveBeenNthCalledWith(2, '[MOD.V1+:sub]', 'enabled-sub');

    debugSpy.mockClear();
    helpers.store.set(`${types.SETTING_PREFIX}debugSpecialPlus`, false);
    helpers.store.set(`${types.SETTING_PREFIX}debugModPrefix`, true);
    helpers.logDebug('[MOD] msg');
    helpers.logDebug('[MOD.V1+] msg');
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenNthCalledWith(1, '[MOD] msg');

    debugSpy.mockClear();
    settings.Settings.set('debugNoPat', true);
    expect(noPatCtx.debug.enabled()).toBe(true);
    noPatCtx.debug.log('hello');
    helpers.logDebug('[NOPATMOD] direct-ok');
    expect(debugSpy).toHaveBeenNthCalledWith(1, '[NOPATMOD]', 'hello');
    expect(debugSpy).toHaveBeenNthCalledWith(2, '[NOPATMOD] direct-ok');
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
