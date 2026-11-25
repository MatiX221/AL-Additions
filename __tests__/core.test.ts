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

    addMod('featBeta', 'feature', { after: ['featAlpha'] });
    addMod('featAlpha', 'feature', { after: ['featBeta'] });
    addMod('svcCore', 'service');
    addMod('svcChild', 'service', { dependsOn: ['svcCore'] });
    addMod('preMod', 'preload');
    addMod('intMod', 'intercept');
    registry.registerShellModule('shellUi', () => {
      order.push('shellUi');
    });

    addMod('cycle1', 'feature', { dependsOn: ['cycle2'] });
    addMod('cycle2', 'feature', { dependsOn: ['cycle1'] });

    addMod('svcIllegal', 'service', { dependsOn: ['featAlpha'] });

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
    accounts.registerAccountProvider({
      id: 'undeclared',
      name: 'Undeclared',
      secretKeys: ['undeclared_secret'],
      isConnected: () => true,
      connect: () => {},
      disconnect: () => {}
    });

    helpers.store.set('mal_token', 'abc');
    helpers.store.set('other_secret', 'xyz');
    helpers.store.set('undeclared_secret', 'keep');

    let capturedCtx!: any;
    let routeAborted = false;
    const mountTargets: HTMLElement[] = [];

    registry.defineModule({
      id: 'ctxSuite',
      key: 'ctxSuiteEnabled',
      layer: 'feature',
      requiresReload: false,
      accounts: ['mal', 'anilist'],
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
        expect(globalThis.GM_getValue).not.toHaveBeenCalledWith('ala_mod_ctxSuite_myCache', expect.anything());
        vi.useFakeTimers();
        try {
          p.data.count = 7;
          p.save();
          vi.advanceTimersByTime(550);
          expect(helpers.jsonGet('ala_mod_ctxSuite_myCache', null)).toEqual({ count: 7 });
        } finally {
          vi.useRealTimers();
        }

        (ctx.events as any).on('ping', (payload: unknown) => log.push(`event:${payload}`));
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
            mountTargets.push(el);
            return el;
          }
        });
      }
    });

    history.replaceState({}, '', '/anime/1');
    settings.Settings.set('ctxSuiteEnabled', true);
    registry.startModules(false);

    expect(document.getElementById('ala-ctxSuite-ctx-test-mount')).not.toBeNull();

    vi.useFakeTimers();
    try {
      document.getElementById('ala-ctxSuite-ctx-test-mount')!.remove();
      expect(document.getElementById('ala-ctxSuite-ctx-test-mount')).toBeNull();
      const trigger = document.createElement('span');
      document.body.appendChild(trigger);
      await Promise.resolve();
      vi.advanceTimersByTime(60);
      expect(document.getElementById('ala-ctxSuite-ctx-test-mount')).not.toBeNull();
      trigger.remove();
    } finally {
      vi.useRealTimers();
    }

    capturedCtx.events.emit('ping', 'hello');
    capturedCtx.menuCommand('Test Menu Cmd', () => log.push('cmd:v2'));
    expect(regSpy).toHaveBeenCalledTimes(1);
    const registeredCallback = regSpy.mock.calls[0][1] as () => void;
    registeredCallback();
    expect(log).toEqual(['event:hello', 'cmd:v2']);

    expect(routeAborted).toBe(false);
    history.pushState({}, '', '/home');
    expect(routeAborted).toBe(true);

    capturedCtx.accounts.clearSecrets('mal');
    expect(helpers.store.get('mal_token', null)).toBeNull();
    expect(helpers.store.get('other_secret', null)).toBe('xyz');
    expect(helpers.store.get('undeclared_secret', null)).toBe('keep');

    capturedCtx.accounts.clearSecrets();
    expect(helpers.store.get('other_secret', null)).toBeNull();
    expect(helpers.store.get('undeclared_secret', null)).toBe('keep');

    const abortFn = vi.fn();
    xhrSpy.mockImplementation(() => ({ abort: abortFn }) as any);
    const pendingReq = capturedCtx.http.text('https://example.com/slow');

    settings.Settings.set('ctxSuiteEnabled', false);
    registry.createModuleHost().reload(['ctxSuite']);

    await expect(pendingReq).rejects.toThrow('Request aborted');
    expect(abortFn).toHaveBeenCalledTimes(1);
    expect(document.getElementById('ala-ctxSuite-ctx-test-mount')).toBeNull();

    capturedCtx.storage.clear();
    expect(capturedCtx.storage.get('item', null)).toBeNull();
    expect(helpers.jsonGet('ala_mod_ctxSuite_myCache', null)).toBeNull();
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

    const malToggle = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="malEditEnabled"]')!;
    expect(malToggle.disabled).toBe(false);
    expect(
      document.querySelector('[data-feature="malEditMod"] .ala-host-note')?.textContent
    ).toContain('myanimelist.net');

    const parentToggle = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="parentEnabled"]')!;
    const childToggle = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="childEnabled"]')!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;

    expect(childToggle.checked).toBe(true);
    expect(saveBtn.textContent).toBe('Save');

    parentToggle.checked = false;
    parentToggle.dispatchEvent(new Event('change', { bubbles: true }));

    expect(childToggle.disabled).toBe(true);
    expect(childToggle.checked).toBe(true);
    expect(document.querySelector('[data-feature="childReloadMod"] .ala-dep-note')?.textContent).toContain(
      'Parent Service'
    );
    expect(saveBtn.textContent).toBe('Save and reload');

    parentToggle.checked = true;
    parentToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(childToggle.disabled).toBe(false);
    expect(childToggle.checked).toBe(true);
    expect(saveBtn.textContent).toBe('Save');

    const ovToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="manualOverridesEnabled"]'
    )!;
    expect(ovToggle.checked).toBe(false);
    document.querySelector<HTMLButtonElement>('#ala-btn-edit-syncManualOverrides')!.click();
    expect(ovToggle.checked).toBe(true);

    const reloadSpy = vi.spyOn(host, 'reload');
    saveBtn.click();
    expect(reloadSpy).toHaveBeenCalledWith(['manualOverrides']);
    expect(settings.Settings.get('manualOverridesEnabled')).toBe(true);

    standaloneFound = true;
    await host.probeStandalone('childReloadMod');
    expect(host.getStatus('childReloadMod').reason).toBe('standalone-paused');
    expect(
      document.querySelector('[data-feature="childReloadMod"] .ala-standalone-note')?.textContent
    ).toContain('Standalone Child');

    const rawRow = document.querySelector<HTMLElement>('#ala-row-export-raw')!;
    expect(rawRow.style.display).toBe('none');
    const devToggle = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="devModeEnabled"]')!;
    devToggle.checked = true;
    devToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(rawRow.style.display).toBe('');

    panel.closePanel();

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

    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('ala-nyaa-find-on-nyaa')).not.toBeNull();
    expect(document.getElementById('ala-nyaa-edit-mal-id')).toBeNull();

    settings.Settings.set('manualOverridesEnabled', true);
    registry.createModuleHost().reload(['manualOverrides']);
    expect(document.getElementById('ala-nyaa-edit-mal-id')).not.toBeNull();

    const nyaaLink = document.getElementById('ala-nyaa-find-on-nyaa') as HTMLAnchorElement;
    malOverrides.setOverride(16498, { malId: 0, type: 'ANIME', title: 'AoT' });
    bus.EventBus.emit('manualOverrides:changed', 16498);
    expect(nyaaLink.title).toBe('Marked as AniList-Only (searches Nyaa)');

    settings.Settings.set('manualOverridesEnabled', false);
    registry.createModuleHost().reload(['manualOverrides']);
    expect(document.getElementById('ala-nyaa-edit-mal-id')).toBeNull();
  });

  it('enforces compile-time EventMap and ServiceMap key/payload contracts without runtime overhead', async () => {
    const { registry, settings, bus } = await loadFreshKernel();
    await import('../src/modules/sync');

    let receivedId: number | undefined;
    const unsubEvent = bus.EventBus.on('manualOverrides:changed', (id) => {
      receivedId = id;
    });
    bus.EventBus.emit('manualOverrides:changed', 4242);
    expect(receivedId).toBe(4242);
    unsubEvent();

    let checked = false;
    registry.defineModule({
      id: 'typedConsumer',
      key: 'typedConsumerEnabled',
      title: 'Typed Consumer',
      help: 'Type-checks EventMap and ServiceMap',
      setup(ctx) {
        checked = true;
        const svc = ctx.services.get('manualOverrides:quickEdit');
        expect(svc).toBeUndefined();

        if (false as boolean) {
          // @ts-expect-error unknown event key
          ctx.events.emit('nonexistent:event', 1);
          // @ts-expect-error mismatched payload type
          ctx.events.emit('manualOverrides:changed', 'wrong-type');
          // @ts-expect-error unknown service key
          ctx.services.get('manualOverrides:nonexistent');
          // @ts-expect-error typedConsumer cannot provide manualOverrides's service
          ctx.services.provide('quickEdit', () => {});
        }
      }
    });
    settings.Settings.set('typedConsumerEnabled', true);
    registry.startModules(false);
    expect(checked).toBe(true);
  });

  it('cascades teardown on async setup rejection, ignores stale bootSeq, and cascades standalone pauses', async () => {
    const { registry, settings } = await loadFreshKernel();
    const host = registry.createModuleHost();
    const log: string[] = [];

    let rejectFirstSvc!: (e: Error) => void;
    let svcAttempt = 0;
    let triggerLatePause!: () => void;
    let probeResult = false;

    registry.defineModule({
      id: 'asyncDep',
      key: 'asyncDepEnabled',
      layer: 'service',
      title: 'Async Dep',
      help: 'Test',
      setup(ctx) {
        const attempt = ++svcAttempt;
        log.push(`asyncDep:setup:${attempt}`);
        ctx.onCleanup(() => log.push(`asyncDep:cleanup:${attempt}`));
        if (attempt === 1) {
          return new Promise<void>((_res, rej) => {
            rejectFirstSvc = rej;
          });
        }
        return Promise.resolve();
      }
    });

    registry.defineModule({
      id: 'asyncChild',
      key: 'asyncChildEnabled',
      layer: 'feature',
      dependsOn: ['asyncDep'],
      title: 'Async Child',
      help: 'Test',
      setup(ctx) {
        const run = svcAttempt;
        log.push(`asyncChild:setup:${run}`);
        ctx.onCleanup(() => log.push(`asyncChild:cleanup:${run}`));
      }
    });

    settings.Settings.set('asyncDepEnabled', true);
    settings.Settings.set('asyncChildEnabled', true);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.startModules(false);
      expect(log).toEqual(['asyncDep:setup:1', 'asyncChild:setup:1']);

      host.reload(['asyncDep']);
      expect(log).toContain('asyncChild:cleanup:1');
      expect(log).toContain('asyncDep:cleanup:1');
      expect(log).toContain('asyncDep:setup:2');
      expect(log).toContain('asyncChild:setup:2');

      rejectFirstSvc(new Error('stale rejection'));
      await Promise.resolve();
      await Promise.resolve();
      expect(host.getStatus('asyncDep')).toEqual({ active: true });
      expect(host.getStatus('asyncChild')).toEqual({ active: true });
      expect(log).not.toContain('asyncChild:cleanup:2');

      svcAttempt = 0;
      host.reload(['asyncDep']);
      rejectFirstSvc(new Error('async boom'));
      await Promise.resolve();
      await Promise.resolve();

      expect(host.getStatus('asyncDep')).toEqual({ active: false, reason: 'error', error: 'async boom' });
      expect(host.getStatus('asyncChild')).toEqual({
        active: false,
        reason: 'dep-unavailable',
        missingDeps: ['asyncDep']
      });
    } finally {
      errSpy.mockRestore();
    }

    registry.defineModule({
      id: 'stParent',
      key: 'stParentEnabled',
      layer: 'service',
      title: 'Standalone Parent',
      help: 'Test',
      standalone: { name: 'Standalone', probe: () => probeResult },
      setup(ctx) {
        log.push('stParent:setup');
        ctx.onCleanup(() => log.push('stParent:cleanup'));
        triggerLatePause = () => ctx.setStandalonePaused(true);
      }
    });
    registry.defineModule({
      id: 'stChild',
      key: 'stChildEnabled',
      layer: 'feature',
      dependsOn: ['stParent'],
      title: 'Standalone Child',
      help: 'Test',
      setup(ctx) {
        log.push('stChild:setup');
        ctx.onCleanup(() => log.push('stChild:cleanup'));
      }
    });
    settings.Settings.set('stParentEnabled', true);
    settings.Settings.set('stChildEnabled', true);
    registry.startModules(false);

    triggerLatePause();
    expect(log.slice(-2)).toEqual(['stChild:cleanup', 'stParent:cleanup']);
    expect(host.getStatus('stParent')).toEqual({ active: false, reason: 'standalone-paused' });
    expect(host.getStatus('stChild')).toEqual({
      active: false,
      reason: 'dep-unavailable',
      missingDeps: ['stParent']
    });

    host.reload(['stParent']);
    expect(host.getStatus('stParent')).toEqual({ active: true });
    expect(host.getStatus('stChild')).toEqual({ active: true });
    probeResult = true;
    await host.probeStandalone('stParent');
    expect(host.getStatus('stParent')).toEqual({ active: false, reason: 'standalone-paused' });
    expect(host.getStatus('stChild')).toEqual({
      active: false,
      reason: 'dep-unavailable',
      missingDeps: ['stParent']
    });
  });

  it('handles cross-realm URL/Request objects and bodyUsed guards in CoreHooks fallback fetch', async () => {
    const { bus } = await loadFreshKernel();
    const events: any[] = [];

    class ForeignURL {
      href: string;
      constructor(raw: string) {
        this.href = raw;
      }
    }
    class ForeignRequest {
      url: string;
      method: string;
      bodyUsed: boolean;
      private readonly rawBody: string;
      constructor(url: string, rawBody: string, bodyUsed = false) {
        this.url = url;
        this.method = 'POST';
        this.rawBody = rawBody;
        this.bodyUsed = bodyUsed;
      }
      clone() {
        return {
          text: async () => this.rawBody
        };
      }
    }

    const origWinRequest = (window as any).Request;
    const origWinFetch = window.fetch;

    try {
      (window as any).Request = ForeignRequest;
      window.fetch = (async (input: any) => {
        const reqUrl = typeof input === 'string' ? input : input.href || input.url;
        if (reqUrl.includes('used-res')) {
          return {
            status: 200,
            ok: true,
            bodyUsed: true,
            clone() {
              throw new Error('should not clone when bodyUsed is true');
            }
          } as any;
        }
        return new Response(JSON.stringify({ data: { Viewer: { id: 7 } } }), { status: 200 });
      }) as any;

      const unsub = bus.CoreHooks.onGqlFetch((ev) => events.push(ev));

      await window.fetch(new ForeignURL('https://anilist.co/graphql') as any, {
        method: 'POST',
        body: JSON.stringify({ query: 'query UrlTest { Viewer { id } }' })
      });
      await window.fetch(
        new ForeignRequest(
          'https://graphql.anilist.co',
          JSON.stringify({ query: 'query ReqTest { Viewer { id } }', variables: { ok: true } })
        ) as any
      );
      const resUsed = await window.fetch(new ForeignURL('https://anilist.co/graphql?used-res') as any, {
        method: 'POST',
        body: JSON.stringify({ query: 'query BodyUsedTest { Viewer { id } }' })
      });
      expect(resUsed.status).toBe(200);
      await window.fetch(
        new ForeignRequest(
          'https://anilist.co/graphql',
          JSON.stringify({ query: 'query SkippedReq { Viewer { id } }' }),
          true
        ) as any
      );

      expect(events.map((e) => [e.phase, e.query.slice(0, 13), e.data])).toEqual([
        ['request', 'query UrlTest', undefined],
        ['response', 'query UrlTest', { Viewer: { id: 7 } }],
        ['request', 'query ReqTest', undefined],
        ['response', 'query ReqTest', { Viewer: { id: 7 } }],
        ['request', 'query BodyUse', undefined],
        ['response', 'query BodyUse', undefined]
      ]);

      unsub();
    } finally {
      window.fetch = origWinFetch;
      (window as any).Request = origWinRequest;
    }
  });

  it('supports emitRetained/onRetained across boot phases with emit() coherence and owner cleanup', async () => {
    const { registry, settings } = await loadFreshKernel();
    const host = registry.createModuleHost();
    const received: number[] = [];

    let emitterVersion = 0;
    let secondModuleUpdate!: () => void;

    registry.defineModule({
      id: 'retainedEarly',
      key: 'retainedEarlyEnabled',
      layer: 'preload',
      title: 'Retained Early',
      help: 'Test',
      setup(ctx) {
        emitterVersion++;
        ctx.events.emitRetained('manualOverrides:changed', emitterVersion * 100);
        ctx.events.emit('manualOverrides:changed', emitterVersion * 100 + 1);
      }
    });

    registry.defineModule({
      id: 'retainedOther',
      key: 'retainedOtherEnabled',
      layer: 'feature',
      title: 'Retained Other',
      help: 'Test',
      setup(ctx) {
        secondModuleUpdate = () => ctx.events.emitRetained('manualOverrides:changed', 999);
      }
    });

    registry.defineModule({
      id: 'retainedLate',
      key: 'retainedLateEnabled',
      layer: 'feature',
      title: 'Retained Late',
      help: 'Test',
      setup(ctx) {
        ctx.events.onRetained('manualOverrides:changed', (id) => received.push(id));
      }
    });

    settings.Settings.set('retainedEarlyEnabled', true);
    settings.Settings.set('retainedOtherEnabled', true);
    settings.Settings.set('retainedLateEnabled', true);

    registry.startModules(true);
    registry.startModules(false);
    expect(received).toEqual([101]);

    secondModuleUpdate();
    expect(received).toEqual([101, 999]);
    settings.Settings.set('retainedEarlyEnabled', false);
    host.reload(['retainedEarly']);

    const lateCheck: number[] = [];
    const { bus } = await import('../src/core/bus').then((m) => ({ bus: m }));
    const unsubCheck = bus.EventBus.onRetained('manualOverrides:changed', (id) => lateCheck.push(id));
    expect(lateCheck).toEqual([999]);
    unsubCheck();

    settings.Settings.set('retainedOtherEnabled', false);
    host.reload(['retainedOther']);

    const afterDisable: number[] = [];
    const unsubNone = bus.EventBus.onRetained('manualOverrides:changed', (id) => afterDisable.push(id));
    expect(afterDisable).toEqual([]);
    unsubNone();
  });

  it('provides ctx.getId, 1-arg/2-arg lazy addStyle with in-place updates, MountHandle with route-scoped style, and ctx.modal auto-cleanup', async () => {
    const { registry, settings } = await loadFreshKernel();
    const styles = await import('../src/core/styles');

    let capturedCtx: any;
    let routeMount!: any;
    let modalCloses = 0;
    let openModalHandle: any = null;
    let styleTagExistedBeforeInsert = false;

    document.body.innerHTML = '<div id="mount-root"></div>';
    history.replaceState({}, '', '/anime/42');

    registry.defineModule({
      id: 'ergoMod',
      key: 'ergoModEnabled',
      title: 'Ergonomics Mod',
      help: 'Test',
      setup(ctx) {
        capturedCtx = ctx;

        expect(ctx.getId('panel')).toBe('ala-ergoMod-panel');
        expect(ctx.getId('ala-ergoMod-panel')).toBe('ala-ergoMod-panel');
        expect(ctx.getId()).toBe('ala-ergoMod-1');
        expect(ctx.getId()).toBe('ala-ergoMod-2');

        ctx.addStyle('body { opacity: 1; }');
        ctx.addStyle('modal', () => '.m { color: red; }');
        ctx.addStyle('modal', () => '.m { color: blue; }');
        ctx.addStyle('card-style', '.c { color: green; }');

        ctx.onRoute(/^\/anime\/\d+/, (rc) => {
          rc.addStyle('.route-only { display: block; }');
          routeMount = rc.mount({
            anchor: '#mount-root',
            position: 'beforeend',
            ownUi: true,
            style: (sel) => `${sel} { color: rgb(1, 2, 3); }`,
            create: () => {
              const div = document.createElement('div');
              div.textContent = 'mounted';
              return div;
            }
          });
          styleTagExistedBeforeInsert = !!document.getElementById(`${routeMount.id}-style`);
        });
      }
    });

    const origInsert = Element.prototype.insertAdjacentElement;
    const spyInsert = vi.spyOn(Element.prototype, 'insertAdjacentElement').mockImplementation(function (
      this: Element,
      pos: InsertPosition,
      el: Element
    ) {
      styleTagExistedBeforeInsert = !!document.getElementById(`${el.id}-style`);
      return origInsert.call(this, pos, el);
    });

    settings.Settings.set('ergoModEnabled', true);
    try {
      registry.startModules(false);
    } finally {
      spyInsert.mockRestore();
    }

    expect(document.getElementById('ala-ergoMod-style-1')?.textContent).toBe('body { opacity: 1; }');
    expect(document.getElementById('ala-ergoMod-modal-style')?.textContent).toBe('.m { color: blue; }');
    expect(document.getElementById('ala-ergoMod-card-style')?.textContent).toBe('.c { color: green; }');
    expect(document.getElementById('ala-ergoMod-route-style-2')?.textContent).toBe('.route-only { display: block; }');

    expect(routeMount.id).toBe('ala-ergoMod-mount-1');
    expect(routeMount.selector).toBe('#ala-ergoMod-mount-1');
    expect(routeMount.el()).not.toBeNull();
    expect(styleTagExistedBeforeInsert).toBe(true);
    expect(document.getElementById('ala-ergoMod-mount-1-style')?.textContent).toBe(
      '#ala-ergoMod-mount-1 { color: rgb(1, 2, 3); }'
    );

    vi.useFakeTimers();
    try {
      routeMount.el()!.remove();
      document.body.appendChild(document.createElement('span'));
      await Promise.resolve();
      vi.advanceTimersByTime(60);
      expect(routeMount.el()).not.toBeNull();
      expect(document.getElementById('ala-ergoMod-mount-1-style')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }

    history.pushState({}, '', '/home');
    expect(routeMount.el()).toBeNull();
    expect(document.getElementById('ala-ergoMod-mount-1-style')).toBeNull();
    expect(document.getElementById('ala-ergoMod-route-style-2')).toBeNull();
    expect(document.getElementById('ala-ergoMod-style-1')).not.toBeNull();

    openModalHandle = capturedCtx.modal({
      title: 'Test Modal',
      bodyHtml: '<p>Hello</p>',
      footerHtml: '<button type="button">OK</button>',
      onClose: () => {
        modalCloses++;
      }
    });
    expect(openModalHandle.backdrop.id).toBe('ala-ergoMod-modal-1');
    expect(document.getElementById('ala-ergoMod-modal-1')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modalCloses).toBe(1);
    expect(document.getElementById('ala-ergoMod-modal-1')).toBeNull();

    openModalHandle = capturedCtx.modal({
      id: 'second',
      title: 'Second Modal',
      onClose: () => {
        modalCloses++;
      }
    });
    expect(document.getElementById('ala-ergoMod-second')).not.toBeNull();

    registry.disposeFeature('ergoMod');
    expect(modalCloses).toBe(2);
    expect(document.getElementById('ala-ergoMod-second')).toBeNull();
    expect(document.getElementById('ala-ergoMod-style-1')).toBeNull();
    expect(document.getElementById('ala-ergoMod-modal-style')).toBeNull();
    expect(document.getElementById('ala-ergoMod-card-style')).toBeNull();

    const sClean = styles.addStyle('live-upd', '.a { color: red; }');
    expect(document.getElementById('ala-live-upd')?.textContent).toBe('.a { color: red; }');
    const sClean2 = styles.addStyle('ala-live-upd', () => '.a { color: green; }');
    expect(document.getElementById('ala-live-upd')?.textContent).toBe('.a { color: green; }');
    sClean();
    expect(document.getElementById('ala-live-upd')).not.toBeNull();
    sClean2();
    expect(document.getElementById('ala-live-upd')).toBeNull();
  });
});
