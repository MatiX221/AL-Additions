import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadFreshKernel() {
  vi.resetModules();
  const [types, helpers, observer, bus, accounts, settings, devMode, panel, registry, anilist, mal, malOverrides] =
    await Promise.all([
      import('../src/types'),
      import('../src/utils/helpers'),
      import('../src/core/observer'),
      import('../src/core/bus'),
      import('../src/core/accounts'),
      import('../src/settings/settings'),
      import('../src/settings/devMode'),
      import('../src/settings/panel'),
      import('../src/core/registry'),
      import('../src/api/anilist'),
      import('../src/api/mal'),
      import('../src/api/malOverrides')
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
    panel,
    registry,
    anilist,
    mal,
    malOverrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Core Microkernel: Registration, Statuses & Boot Order', () => {
  it('assigns invalid-id, id-collision, disabled, host-mismatch, and error statuses accurately', async () => {
    const { registry, settings } = await loadFreshKernel();
    const host = registry.createModuleHost();

    registry.defineModule({
      id: 'Invalid ID!',
      key: 'badIdKey',
      title: 'Bad',
      help: 'Bad',
      setup: () => {}
    });
    expect(host.getStatus('Invalid ID!')).toEqual({ active: false, reason: 'invalid-id' });
    expect(settings.ROWS.badIdKey).toBeUndefined();

    registry.defineModule({
      id: 'modA',
      key: 'modAEnabled',
      layer: 'feature',
      title: 'Mod A',
      help: 'First',
      setup: () => {}
    });
    registry.defineModule({
      id: 'modA',
      key: 'modADupEnabled',
      layer: 'feature',
      title: 'Mod A Dup',
      help: 'Dup',
      setup: () => {}
    });
    expect(host.getStatus('modA')).toEqual({ active: false, reason: 'id-collision' });

    registry.defineModule({
      id: 'malOnly',
      key: 'malOnlyEnabled',
      hosts: ['myanimelist.net'],
      title: 'MAL Only',
      help: 'MAL only',
      setup: () => {}
    });
    expect(host.getStatus('malOnly')).toEqual({ active: false, reason: 'host-mismatch' });

    registry.defineModule({
      id: 'wildCardMod',
      key: 'wildCardEnabled',
      hosts: ['*'],
      title: 'Wildcard',
      help: 'Runs everywhere',
      setup: () => {}
    });
    expect(host.getStatus('wildCardMod')).toEqual({ active: false, reason: 'disabled' });
    settings.Settings.set('wildCardEnabled', true);

    registry.defineModule({
      id: 'brokenMod',
      key: 'brokenEnabled',
      title: 'Broken',
      help: 'Throws',
      setup: () => {
        throw new Error('boom during setup');
      }
    });
    settings.Settings.set('brokenEnabled', true);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.startModules(false);
    } finally {
      errSpy.mockRestore();
    }

    expect(host.getStatus('wildCardMod')).toEqual({ active: true });
    expect(host.getStatus('brokenMod')).toEqual({
      active: false,
      reason: 'error',
      error: 'boom during setup'
    });
  });

  it('boots strictly across 5 layers, respects after/dependsOn ordering, detects cycles & layer conflicts, and tears down in reverse', async () => {
    const { registry, settings } = await loadFreshKernel();
    const order: string[] = [];
    const tornDown: string[] = [];

    const addMod = (
      id: string,
      layer: 'intercept' | 'preload' | 'service' | 'feature',
      extra: Record<string, any> = {}
    ) => {
      const key = `${id}Enabled`;
      registry.defineModule({
        id,
        key,
        layer,
        requiresReload: false,
        title: id,
        help: id,
        ...extra,
        setup(ctx) {
          order.push(id);
          ctx.onCleanup(() => tornDown.push(id));
        }
      });
      settings.Settings.set(key, true);
    };

    // Soft-cycle on `after` should still boot both deterministically alphabetically
    addMod('featBeta', 'feature', { after: ['featAlpha'] });
    addMod('featAlpha', 'feature', { after: ['featBeta'] });
    addMod('svcCore', 'service');
    addMod('svcChild', 'service', { dependsOn: ['svcCore'] });
    addMod('preMod', 'preload');
    addMod('intMod', 'intercept');
    registry.registerShellModule('shellUi', () => {
      order.push('shellUi');
    });

    // Hard cycle on `dependsOn`
    addMod('cycle1', 'feature', { dependsOn: ['cycle2'] });
    addMod('cycle2', 'feature', { dependsOn: ['cycle1'] });

    // Higher-layer dependency violation (`service` depending on `feature`)
    addMod('svcIllegal', 'service', { dependsOn: ['featAlpha'] });

    // Depending on a host-mismatched module yields dep-unavailable
    registry.defineModule({
      id: 'malDep',
      key: 'malDepEnabled',
      hosts: ['myanimelist.net'],
      title: 'MAL Dep',
      help: 'MAL',
      setup: () => {}
    });
    settings.Settings.set('malDepEnabled', true);
    addMod('alOnMal', 'feature', { dependsOn: ['malDep'] });

    registry.startModules(true);
    expect(order).toEqual(['intMod', 'preMod']);

    registry.startModules(false);
    expect(order).toEqual([
      'intMod',
      'preMod',
      'svcCore',
      'svcChild',
      'featAlpha',
      'featBeta',
      'shellUi'
    ]);

    const host = registry.createModuleHost();
    expect(host.getStatus('cycle1')).toEqual({ active: false, reason: 'cycle' });
    expect(host.getStatus('cycle2')).toEqual({ active: false, reason: 'cycle' });
    expect(host.getStatus('svcIllegal').reason).toBe('layer-conflict');
    expect(host.getStatus('alOnMal').reason).toBe('dep-unavailable');

    // Disable svcCore and reload -> svcChild tears down before svcCore cleanly
    settings.Settings.set('svcCoreEnabled', false);
    host.reload(['svcCore']);
    expect(tornDown.indexOf('svcChild')).toBeLessThan(tornDown.indexOf('svcCore'));
  });

  it('isolates migrate(), sync/async setup(), and CleanupFn throws so shell still boots and subsequent cleanups run', async () => {
    const { registry, settings } = await loadFreshKernel();
    const events: string[] = [];

    registry.defineModule({
      id: 'badMigrate',
      key: 'badMigrateEnabled',
      layer: 'service',
      title: 'Bad Migrate',
      help: 'Throws',
      migrate() {
        throw new Error('migrate fail');
      },
      setup() {
        events.push('badMigrate:setup');
      }
    });

    registry.defineModule({
      id: 'badAsync',
      key: 'badAsyncEnabled',
      layer: 'feature',
      requiresReload: false,
      title: 'Bad Async',
      help: 'Rejects',
      async setup(ctx) {
        ctx.onCleanup(() => events.push('clean1'));
        ctx.onCleanup(() => {
          throw new Error('cleanup throw');
        });
        ctx.onCleanup(() => events.push('clean3'));
        await Promise.resolve();
        throw new Error('async reject');
      }
    });

    registry.defineModule({
      id: 'badSync',
      key: 'badSyncEnabled',
      layer: 'feature',
      title: 'Bad Sync',
      help: 'Throws',
      setup() {
        throw new Error('sync throw');
      }
    });

    registry.registerShellModule('healthyShell', () => {
      events.push('healthyShell');
    });

    settings.Settings.set('badMigrateEnabled', true);
    settings.Settings.set('badAsyncEnabled', true);
    settings.Settings.set('badSyncEnabled', true);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.runMigrations();
      registry.startModules(false);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      errSpy.mockRestore();
    }

    expect(events).toContain('badMigrate:setup');
    expect(events).toContain('healthyShell');
    // CleanupFn throws inside clean2 should not prevent clean1 or clean3 from running
    expect(events).toContain('clean3');
    expect(events).toContain('clean1');
  });

  it('runs Settings.migrate() before disabled module migrate() hooks including ALAdditions localStorage fallback', async () => {
    const { registry, settings, malOverrides, types } = await loadFreshKernel();
    localStorage.setItem(
      'ALAdditions:syncManualOverrides',
      JSON.stringify({ '555': { malId: 777, type: 'ANIME', title: 'Fallback Show', updatedAt: 100 } })
    );

    let sawOverridesInMigrate = 0;
    registry.defineModule({
      id: 'overrideMigTest',
      key: malOverrides.MANUAL_OVERRIDES_ENABLED_KEY,
      layer: 'service',
      title: 'Manual Overrides',
      help: 'Test',
      options: [
        {
          key: malOverrides.OVERRIDES_SETTING_KEY,
          type: 'json',
          def: {},
          legacy: [malOverrides.OVERRIDES_SETTING_KEY],
          title: 'Overrides',
          help: 'Overrides'
        }
      ],
      migrate() {
        const all = malOverrides.getManualOverrides();
        sawOverridesInMigrate = Object.keys(all).length;
        if (
          sawOverridesInMigrate > 0 &&
          storeGet(types.SETTING_PREFIX + malOverrides.MANUAL_OVERRIDES_ENABLED_KEY) === undefined
        ) {
          globalThis.GM_setValue(types.SETTING_PREFIX + malOverrides.MANUAL_OVERRIDES_ENABLED_KEY, true);
        }
      },
      setup: () => {}
    });

    const storeGet = (k: string) => globalThis.GM_getValue(k, undefined);
    expect(settings.Settings.get(malOverrides.MANUAL_OVERRIDES_ENABLED_KEY)).toBe(false);

    registry.runMigrations();

    expect(sawOverridesInMigrate).toBe(1);
    expect(malOverrides.isManualOverridesEnabled()).toBe(true);
    expect(malOverrides.getEffectiveMalId(555, null)).toBe(777);
  });

  it('cancels ctx.ready DOMContentLoaded listener when module is disposed before ready fires', async () => {
    const { registry, settings } = await loadFreshKernel();
    const readySpy = vi.fn();
    const origBody = document.body;

    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      registry.defineModule({
        id: 'earlyReadyMod',
        key: 'earlyReadyEnabled',
        layer: 'service',
        requiresReload: false,
        title: 'Early Ready',
        help: 'Test',
        setup(ctx) {
          ctx.ready(readySpy);
        }
      });
      settings.Settings.set('earlyReadyEnabled', true);
      registry.startModules(false);

      // Disable & reload before DOMContentLoaded arrives
      settings.Settings.set('earlyReadyEnabled', false);
      registry.createModuleHost().reload(['earlyReadyMod']);

      delete (document as any).body;
      if (!document.body && origBody) document.documentElement.appendChild(origBody);
      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(readySpy).not.toHaveBeenCalled();
    } finally {
      delete (document as any).body;
      if (!document.body && origBody) document.documentElement.appendChild(origBody);
    }
  });
});

describe('Core Microkernel: FeatureContext & Runtime Utilities', () => {
  it('supports storage namespacing/watch/clear, lazy persistent(), http abort, accounts clearSecrets, events, and menu dedupe', async () => {
    const { registry, settings, helpers, accounts } = await loadFreshKernel();
    const log: string[] = [];

    const regSpy = vi.spyOn(globalThis, 'GM_registerMenuCommand');
    const xhrSpy = vi.spyOn(globalThis, 'GM_xmlhttpRequest');

    accounts.registerAccountProvider({
      id: 'mal',
      name: 'MAL',
      secretKeys: ['mal_token', 'mal_refresh_token'],
      isConnected: () => !!helpers.store.get('mal_token', null),
      connect: () => {},
      disconnect: () => accounts.clearAccountSecrets('mal')
    });
    accounts.registerAccountProvider({
      id: 'anilist',
      name: 'Other',
      secretKeys: ['other_secret'],
      isConnected: () => true,
      connect: () => {},
      disconnect: () => {}
    });

    helpers.store.set('mal_token', 'abc');
    helpers.store.set('other_secret', 'xyz');

    let capturedCtx!: any;
    let routeAborted = false;
    const mountTargets: HTMLElement[] = [];

    registry.defineModule({
      id: 'ctxSuite',
      key: 'ctxSuiteEnabled',
      layer: 'feature',
      requiresReload: false,
      title: 'Ctx Suite',
      help: 'Test',
      setup(ctx) {
        capturedCtx = ctx;
        const watchChanges: any[] = [];
        ctx.storage.watch('item', (k, _oldV, newV) => watchChanges.push([k, newV]));
        ctx.storage.set('item', 42);
        expect(ctx.storage.get('item', 0)).toBe(42);
        expect(helpers.store.get('ala_mod_ctxSuite_item', null)).toBe(42);
        expect(watchChanges).toEqual([['item', 42]]);

        const p = ctx.persistent<{ count: number }>('myCache');
        expect(globalThis.GM_getValue).not.toHaveBeenCalledWith('myCache', expect.anything());
        vi.useFakeTimers();
        try {
          p.data.count = 7;
          p.save();
          vi.advanceTimersByTime(550);
          expect(helpers.jsonGet('myCache', null)).toEqual({ count: 7 });
        } finally {
          vi.useRealTimers();
        }

        ctx.events.on('ping', (payload) => log.push(`event:${payload}`));
        ctx.menuCommand('Test Menu Cmd', () => log.push('cmd:v1'));

        ctx.onRoute(/\/anime\/\d+/, (rc) => {
          rc.signal.addEventListener('abort', () => {
            routeAborted = true;
          });
        });

        ctx.mount({
          id: 'ctx-test-mount',
          anchor: () => document.body,
          position: 'beforeend',
          create: () => {
            const el = document.createElement('div');
            el.id = 'ctx-test-mount';
            mountTargets.push(el);
            return el;
          }
        });
      }
    });

    history.replaceState({}, '', '/anime/1');
    settings.Settings.set('ctxSuiteEnabled', true);
    registry.startModules(false);

    expect(document.getElementById('ctx-test-mount')).not.toBeNull();

    // ctx.mount repairs removed DOM elements after body mutation batch
    vi.useFakeTimers();
    try {
      document.getElementById('ctx-test-mount')!.remove();
      expect(document.getElementById('ctx-test-mount')).toBeNull();
      const trigger = document.createElement('span');
      document.body.appendChild(trigger);
      await Promise.resolve();
      vi.advanceTimersByTime(60);
      expect(document.getElementById('ctx-test-mount')).not.toBeNull();
      trigger.remove();
    } finally {
      vi.useRealTimers();
    }

    // Events broadcast & menu command update without duplicate GM_registerMenuCommand
    capturedCtx.events.emit('ping', 'hello');
    capturedCtx.menuCommand('Test Menu Cmd', () => log.push('cmd:v2'));
    expect(regSpy).toHaveBeenCalledTimes(1);
    const registeredCallback = regSpy.mock.calls[0][1] as () => void;
    registeredCallback();
    expect(log).toEqual(['event:hello', 'cmd:v2']);

    // Route change aborts old RouteContext signal
    expect(routeAborted).toBe(false);
    history.pushState({}, '', '/home');
    expect(routeAborted).toBe(true);

    // Scoped clearSecrets only clears 'mal'
    capturedCtx.accounts.clearSecrets('mal');
    expect(helpers.store.get('mal_token', null)).toBeNull();
    expect(helpers.store.get('other_secret', null)).toBe('xyz');

    // Omit provider clears all providers
    capturedCtx.accounts.clearSecrets();
    expect(helpers.store.get('other_secret', null)).toBeNull();

    // ctx.http aborts in-flight requests on unload
    const abortFn = vi.fn();
    xhrSpy.mockImplementation(() => ({ abort: abortFn }) as any);
    const pendingReq = capturedCtx.http.text('https://example.com/slow');

    // Unload cleans storage / mounts / aborts XHR
    settings.Settings.set('ctxSuiteEnabled', false);
    registry.createModuleHost().reload(['ctxSuite']);

    await expect(pendingReq).rejects.toThrow('Request aborted');
    expect(abortFn).toHaveBeenCalledTimes(1);
    expect(document.getElementById('ctx-test-mount')).toBeNull();

    capturedCtx.storage.clear();
    expect(capturedCtx.storage.get('item', null)).toBeNull();
  });

  it('guards store.watch and store.list safely when GM_* globals are absent, and handles parseToggle("false") in malOverrides', async () => {
    const { helpers, malOverrides } = await loadFreshKernel();
    const origWatch = globalThis.GM_addValueChangeListener;
    const origList = globalThis.GM_listValues;

    helpers.store.set('ala_manualOverridesEnabled', 'false');
    helpers.store.set('ala_syncManualOverrides', {
      '10': { malId: 99, type: 'ANIME', title: 'Test', updatedAt: 1 }
    });
    expect(malOverrides.isManualOverridesEnabled()).toBe(false);
    expect(malOverrides.getOverride(10)).toBeUndefined();

    (globalThis as any).GM_addValueChangeListener = undefined;
    (globalThis as any).GM_listValues = undefined;
    try {
      expect(helpers.store.list()).toEqual([]);
      const unsub = helpers.store.watch('anyKey', () => {});
      expect(typeof unsub).toBe('function');
      expect(() => unsub()).not.toThrow();
    } finally {
      globalThis.GM_addValueChangeListener = origWatch;
      globalThis.GM_listValues = origList;
    }
  });

  it('handles document-start boot with document.body === null for removeTitle and compareView, plus FastLoad standalone early return', async () => {
    const { registry, settings } = await loadFreshKernel();
    await import('../src/modules/shortUrls');
    await import('../src/modules/compareView');
    await import('../src/modules/fastLoad');

    settings.Settings.set('linkShortenerEnabled', true);
    settings.Settings.set('compareViewEnabled', true);
    settings.Settings.set('fastLoadEnabled', true);

    (window as any).__ANILIST_FAST_LOAD__ = true;

    const origBody = document.body;
    const origReadyState = document.readyState;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });

    try {
      await expect(registry.bootModuleForTest('removeTitle')).resolves.toBeUndefined();
      await expect(registry.bootModuleForTest('compareView')).resolves.toBeUndefined();
      await expect(registry.bootModuleForTest('fastLoad')).resolves.toBeUndefined();
      expect(registry.createModuleHost().getStatus('fastLoad').reason).toBe('standalone-paused');
    } finally {
      delete (window as any).__ANILIST_FAST_LOAD__;
      delete (document as any).body;
      Object.defineProperty(document, 'readyState', { value: origReadyState, configurable: true });
      if (!document.body && origBody) document.documentElement.appendChild(origBody);
    }

    expect(() => document.dispatchEvent(new Event('DOMContentLoaded'))).not.toThrow();
  });

  it('clears al_token_auth via AniList.clearViewer(), mirrors CoreHooks safely, and falls back to core/toast when MAL uiSink is unset', async () => {
    const { bus, helpers, anilist, mal } = await loadFreshKernel();

    helpers.store.set('al_token_auth', 'Bearer jwt_abc');
    helpers.store.set('al_username', 'Alice');
    const clearAuthSpy = vi.fn();
    bus.CoreHooks.registerCacheBridge({
      getGqlStore: () => undefined,
      getRpcCache: () => undefined,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: () => {},
      clearAuth: clearAuthSpy
    });

    anilist.AniList.clearViewer();
    expect(helpers.store.get('al_token_auth', null)).toBeNull();
    expect(helpers.store.get('al_username', null)).toBeNull();
    expect(clearAuthSpy).toHaveBeenCalledTimes(1);

    // CoreHooks host guard: on non-anilist hostname, fallback fetch wrapper must not install
    const origUnsafe = (globalThis as any).unsafeWindow;
    const malFetch = vi.fn();
    (globalThis as any).unsafeWindow = {
      location: { hostname: 'myanimelist.net' },
      fetch: malFetch
    };
    try {
      const unsub = bus.CoreHooks.onGqlFetch(() => {});
      expect((globalThis as any).unsafeWindow.fetch).toBe(malFetch);
      unsub();
    } finally {
      (globalThis as any).unsafeWindow = origUnsafe;
    }

    // CoreHooks __alaCoreMirror resilience when page locks __alaCoreMirror
    const origMirrorDesc = Object.getOwnPropertyDescriptor(globalThis, '__alaCoreMirror');
    Object.defineProperty(globalThis, '__alaCoreMirror', {
      value: Object.freeze({ locked: true }),
      writable: false,
      configurable: true
    });
    try {
      expect(() => bus.CoreHooks.setSessionClearing(true)).not.toThrow();
      expect(() => bus.CoreHooks.setSessionClearing(false)).not.toThrow();
    } finally {
      if (origMirrorDesc) {
        Object.defineProperty(globalThis, '__alaCoreMirror', origMirrorDesc);
      } else {
        delete (globalThis as any).__alaCoreMirror;
      }
    }

    // MAL toast fallback renders core toast without throwing when uiSink is null
    mal.setMalUiSink(null);
    mal.toast('MAL synced without sink', false);
    expect(document.body.textContent).toContain('MAL synced without sink');
  });
});

describe('Core Microkernel: Settings Panel Integration', () => {
  it('supports absent modules cleanly and renders Developer Mode & Backup & Restore', async () => {
    const { panel, registry } = await loadFreshKernel();
    const host = registry.createModuleHost();

    panel.showPanel(host);
    expect(document.querySelector('#ala-settings-panel [data-section="Advanced"]')).not.toBeNull();
    expect(document.querySelector('#ala-settings-panel [data-feature="devMode"]')).not.toBeNull();
    expect(document.querySelector('#ala-settings-panel [data-section="backup"]')).not.toBeNull();
    panel.closePanel();
  });

  it('implements non-destructive dependsOn locking, host-mismatch editable toggles, delayed async standalone re-render, and JSON staging', async () => {
    const { registry, settings, panel } = await loadFreshKernel();
    let standaloneFound = false;

    registry.defineModule({
      id: 'parentMod',
      key: 'parentEnabled',
      layer: 'service',
      requiresReload: false,
      title: 'Parent Service',
      help: 'Parent',
      debug: {
        key: 'debugParent',
        title: 'Parent Debug',
        help: 'Debug'
      },
      setup: () => {}
    });

    registry.defineModule({
      id: 'childReloadMod',
      key: 'childEnabled',
      layer: 'feature',
      requiresReload: true,
      dependsOn: ['parentMod'],
      title: 'Child Feature',
      help: 'Depends on Parent Service',
      standalone: {
        name: 'Standalone Child',
        probe: () => new Promise((res) => setTimeout(() => res(standaloneFound), 10))
      },
      setup: () => {}
    });

    registry.defineModule({
      id: 'malEditMod',
      key: 'malEditEnabled',
      hosts: ['myanimelist.net'],
      requiresReload: false,
      title: 'MAL Only Feature',
      help: 'Editable on AL',
      setup: () => {}
    });

    registry.defineModule({
      id: 'manualOverrides',
      key: 'manualOverridesEnabled',
      requiresReload: false,
      title: 'Manual Overrides',
      help: 'Overrides',
      options: [
        {
          key: 'syncManualOverrides',
          type: 'json',
          def: {},
          title: 'Overrides',
          help: 'JSON',
          editor(ec) {
            ec.onApply({ '42': { malId: 84, type: 'ANIME', title: 'Staged Show', updatedAt: 1 } });
          }
        }
      ],
      setup: () => {}
    });

    settings.Settings.set('parentEnabled', true);
    settings.Settings.set('childEnabled', true);
    registry.startModules(false);

    const host = registry.createModuleHost();
    panel.showPanel(host);

    // Host-mismatch stays editable and shows host note
    const malToggle = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="malEditEnabled"]')!;
    expect(malToggle.disabled).toBe(false);
    expect(
      document.querySelector('[data-feature="malEditMod"] .ala-host-note')?.textContent
    ).toContain('myanimelist.net');

    // Non-destructive dependsOn lock + debug collapse + Save and reload transition
    const parentToggle = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="parentEnabled"]')!;
    const childToggle = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="childEnabled"]')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;

    expect(childToggle.checked).toBe(true);
    expect(saveBtn.textContent).toBe('Save');

    // Turning off a hot-reloadable parent that causes an effective transition on a requiresReload dependent flips Save -> Save and reload!
    parentToggle.checked = false;
    parentToggle.dispatchEvent(new Event('change', { bubbles: true }));

    expect(childToggle.disabled).toBe(true);
    expect(childToggle.checked).toBe(true); // preserved non-destructively!
    expect(document.querySelector('[data-feature="childReloadMod"] .ala-dep-note')?.textContent).toContain(
      'Parent Service'
    );
    expect(saveBtn.textContent).toBe('Save and reload');

    // Re-checking parent unlocks child cleanly & restores Save without reload
    parentToggle.checked = true;
    parentToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(childToggle.disabled).toBe(false);
    expect(childToggle.checked).toBe(true);
    expect(saveBtn.textContent).toBe('Save');

    // Unified JSON sub-modal staging auto-checks manualOverridesEnabled on non-empty syncManualOverrides Apply
    const ovToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="manualOverridesEnabled"]'
    )!;
    expect(ovToggle.checked).toBe(false);
    document.querySelector<HTMLButtonElement>('#ala-btn-edit-syncManualOverrides')!.click();
    expect(ovToggle.checked).toBe(true);

    // Net-diff Save calls host.reload without location.reload
    const reloadSpy = vi.spyOn(host, 'reload');
    saveBtn.click();
    expect(reloadSpy).toHaveBeenCalledWith(['manualOverrides']);
    expect(settings.Settings.get('manualOverridesEnabled')).toBe(true);

    // Delayed async standalone probe transitions live status & renders .ala-standalone-note
    standaloneFound = true;
    await host.probeStandalone('childReloadMod');
    expect(host.getStatus('childReloadMod').reason).toBe('standalone-paused');
    expect(
      document.querySelector('[data-feature="childReloadMod"] .ala-standalone-note')?.textContent
    ).toContain('Standalone Child');

    // DevMode live toggles Export Raw JSON row cleanly
    const rawRow = document.querySelector<HTMLElement>('#ala-row-export-raw')!;
    expect(rawRow.style.display).toBe('none');
    const devToggle = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="devModeEnabled"]')!;
    devToggle.checked = true;
    devToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(rawRow.style.display).toBe('');

    panel.closePanel();

    // Error badge/note rendering when a module fails to boot
    registry.defineModule({
      id: 'panelErrorMod',
      key: 'panelErrorEnabled',
      title: 'Failing Feature',
      help: 'Fails',
      setup() {
        throw new Error('panel failure test');
      }
    });
    settings.Settings.set('panelErrorEnabled', true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.startModules(false);
    } finally {
      errSpy.mockRestore();
    }
    panel.showPanel(host);
    expect(document.querySelector('[data-feature="panelErrorMod"] .ala-badge--error')?.textContent).toBe('Error');
    expect(document.querySelector('[data-feature="panelErrorMod"] .ala-error-note')?.textContent).toContain(
      'panel failure test'
    );
    panel.closePanel();
  });

  it('wires nyaa quick-edit service and manualOverrides:changed tooltip updates cleanly', async () => {
    const { registry, settings, malOverrides, helpers, bus } = await loadFreshKernel();
    await import('../src/modules/sync');
    await import('../src/modules/nyaa');

    helpers.store.set(
      'ala_syncManualOverrides',
      { '16498': { malId: 16498, type: 'ANIME', title: 'AoT', updatedAt: 1 } }
    );
    document.body.innerHTML = '<div class="page-content"><div class="header"><div class="content"><h1>Attack on Titan</h1></div></div></div>';
    history.replaceState({}, '', '/anime/16498');

    settings.Settings.set('nyaaEnabled', true);
    settings.Settings.set('manualOverridesEnabled', false);
    registry.startModules(false);

    // Wait for ctx.waitForSelector immediate resolution in nyaa
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('ala-find-on-nyaa')).not.toBeNull();
    expect(document.getElementById('ala-edit-mal-id')).toBeNull();

    // Enabling manualOverrides attaches #ala-edit-mal-id live
    settings.Settings.set('manualOverridesEnabled', true);
    registry.createModuleHost().reload(['manualOverrides']);
    expect(document.getElementById('ala-edit-mal-id')).not.toBeNull();

    // Ignoring via override + emitting change refreshes tooltip live
    const nyaaLink = document.getElementById('ala-find-on-nyaa') as HTMLAnchorElement;
    malOverrides.setOverride(16498, { malId: 0, type: 'ANIME', title: 'AoT' });
    bus.EventBus.emit('manualOverrides:changed', 16498);
    expect(nyaaLink.title).toBe('Marked as AniList-Only (searches Nyaa)');

    // Disabling manualOverrides removes #ala-edit-mal-id cleanly
    settings.Settings.set('manualOverridesEnabled', false);
    registry.createModuleHost().reload(['manualOverrides']);
    expect(document.getElementById('ala-edit-mal-id')).toBeNull();
  });
});
