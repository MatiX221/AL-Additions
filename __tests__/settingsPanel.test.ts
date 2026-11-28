import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Settings } from '../src/settings/settings';
import { showPanel, closePanel, ensureLauncher, installSidebar, initSettingsPage } from '../src/settings/panel';
import { acquireScrollLock, createModal } from '../src/core/modal';
import { defineModule, createModuleHost } from '../src/core/registry';
import { registerAccountProvider } from '../src/core/accounts';
import * as backup from '../src/settings/backup';
import '../src/settings/devMode';

let registered = false;
let standaloneProbeResult = false;

function ensureTestModulesRegistered(): void {
  if (registered) return;
  registered = true;

  defineModule({
    id: 'panelStandaloneMod',
    key: 'panelStandaloneEnabled',
    section: 'PanelTests',
    requiresReload: true,
    title: 'Standalone Test Feature',
    help: 'Standalone test',
    standalone: {
      name: 'Standalone Tool',
      probe: () => new Promise((resolve) => setTimeout(() => resolve(standaloneProbeResult), 20))
    },
    setup: () => {}
  });

  defineModule({
    id: 'panelDependentMod',
    key: 'panelDependentEnabled',
    section: 'PanelTests',
    requiresReload: true,
    dependsOn: ['panelStandaloneMod'],
    title: 'Dependent Reload Feature',
    help: 'Depends on Standalone Test Feature',
    setup: () => {}
  });

  defineModule({
    id: 'panelOptionsMod',
    key: 'panelOptionsEnabled',
    section: 'PanelTests',
    requiresReload: false,
    title: 'Options & Editors Feature',
    help: 'Options test',
    options: [
      {
        key: 'panelTestNumber',
        type: 'number',
        def: 25,
        min: 10,
        max: 100,
        title: 'Test Number',
        help: 'Number option'
      },
      {
        key: 'panelTestList',
        type: 'list',
        def: ['DefaultGroup'],
        title: 'Test List',
        help: 'List option'
      },
      {
        key: 'panelEditorCloseBtn',
        type: 'json',
        def: {},
        title: 'Editor With Close Button',
        help: 'JSON editor 1',
        editor(ctx) {
          ctx.addStyle('ala-test-editor-close-style', '#ala-test-ed-close { color: red; }');
          const overlay = document.createElement('div');
          overlay.id = 'ala-test-ed-close';
          overlay.innerHTML = '<button type="button" aria-label="Close">X</button>';
          const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
          };
          const close = () => {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
          };
          document.addEventListener('keydown', onKey, true);
          overlay.querySelector('[aria-label="Close"]')?.addEventListener('click', close);
          (window as any).__lastEditorCtxA = ctx;
          document.body.appendChild(overlay);
        }
      },
      {
        key: 'panelEditorEscOnly',
        type: 'json',
        def: {},
        title: 'Editor With Escape Only',
        help: 'JSON editor 2',
        editor(ctx) {
          ctx.addStyle('ala-test-editor-esc-style', '#ala-test-ed-esc { color: blue; }');
          const overlay = document.createElement('div');
          overlay.id = 'ala-test-ed-esc';
          const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
              document.removeEventListener('keydown', onKey, true);
              overlay.remove();
            }
          };
          document.addEventListener('keydown', onKey, true);
          document.body.appendChild(overlay);
        }
      },
      {
        key: 'panelEditorStubborn',
        type: 'json',
        def: {},
        title: 'Stubborn Editor Overlay',
        help: 'JSON editor 3',
        editor(ctx) {
          ctx.addStyle('ala-test-editor-stubborn-style', '#ala-test-ed-stubborn { color: green; }');
          const overlay = document.createElement('div');
          overlay.id = 'ala-test-ed-stubborn';
          document.body.appendChild(overlay);
        }
      },
      {
        key: 'panelEditorModalSession',
        type: 'json',
        def: {},
        title: 'Modal Session Editor',
        help: 'JSON editor 4',
        editor(ctx) {
          const tracker = ((window as any).__modalEditorTracker = {
            keydownCalls: 0,
            timerFired: false,
            onCleanupCalls: 0,
            ctx
          });
          ctx.addStyle('ala-test-editor-session-style', '#ala-test-ed-session { color: pink; }');
          ctx.listen(document, 'keydown', () => {
            tracker.keydownCalls++;
          });
          ctx.timeout(() => {
            tracker.timerFired = true;
          }, 5000);
          ctx.onCleanup(() => {
            tracker.onCleanupCalls++;
          });
          ctx.modal({ id: 'session-modal', title: 'Session Modal' });
        }
      },
      {
        key: 'panelEditorAsyncOverlay',
        type: 'json',
        def: {},
        title: 'Async Overlay Editor',
        help: 'JSON editor 5',
        editor() {
          Promise.resolve().then(() => {
            const overlay = document.createElement('div');
            overlay.id = 'ala-test-ed-async-overlay';
            document.body.appendChild(overlay);
          });
        }
      }
    ],
    setup: () => {}
  });

  defineModule({
    id: 'panelHotBaseMod',
    key: 'panelHotBaseEnabled',
    section: 'PanelTests',
    requiresReload: false,
    title: 'Hot Base Feature',
    help: 'Hot-reloadable base',
    options: [
      {
        key: 'panelHotBaseNum',
        type: 'number',
        def: 10,
        min: 1,
        max: 50,
        title: 'Hot Base Number',
        help: 'Number option'
      }
    ],
    setup: () => {}
  });

  defineModule({
    id: 'panelHotMidMod',
    key: 'panelHotMidEnabled',
    section: 'PanelTests',
    requiresReload: false,
    dependsOn: ['panelHotBaseMod'],
    title: 'Hot Mid Feature',
    help: 'Depends on Hot Base Feature',
    setup: () => {}
  });

  defineModule({
    id: 'panelReloadDepMod',
    key: 'panelReloadDepEnabled',
    section: 'PanelTests',
    requiresReload: true,
    dependsOn: ['panelHotMidMod'],
    title: 'Reload Dependent Feature',
    help: 'Depends on Hot Mid Feature',
    setup: () => {}
  });
}

describe('Settings Panel Lifecycle & Normalization (B1-20)', () => {
  beforeEach(() => {
    ensureTestModulesRegistered();
    standaloneProbeResult = false;
    Settings.set('panelStandaloneEnabled', false);
    Settings.set('panelDependentEnabled', false);
    Settings.set('panelOptionsEnabled', false);
    Settings.set('panelTestNumber', 25);
    Settings.set('panelTestList', ['DefaultGroup']);
    Settings.set('panelHotBaseEnabled', false);
    Settings.set('panelHotBaseNum', 10);
    Settings.set('panelHotMidEnabled', false);
    Settings.set('panelReloadDepEnabled', false);
    Settings.set('devModeEnabled', false);
    delete (window as any).__lastEditorCtxA;
    delete (window as any).__modalEditorTracker;
    history.replaceState({}, '', '/settings');
  });

  afterEach(() => {
    closePanel();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('closes open password modal and style tags when closePanel() runs', async () => {
    showPanel();
    document.querySelector<HTMLButtonElement>('#ala-btn-export')!.click();

    expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();
    expect(document.getElementById('ala-pwd-modal-style')).not.toBeNull();

    closePanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('ala-settings-backdrop')).toBeNull();
    expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
    expect(document.getElementById('ala-pwd-modal-style')).toBeNull();
  });

  it('generically cleans up r.editor overlays (Close button, Escape fallback, .remove fallback), styles, capture listeners, and stale onApply', () => {
    showPanel();

    document.querySelector<HTMLButtonElement>('#ala-btn-edit-panelEditorCloseBtn')!.click();
    document.querySelector<HTMLButtonElement>('#ala-btn-edit-panelEditorEscOnly')!.click();
    document.querySelector<HTMLButtonElement>('#ala-btn-edit-panelEditorStubborn')!.click();

    expect(document.getElementById('ala-test-ed-close')).not.toBeNull();
    expect(document.getElementById('ala-test-ed-esc')).not.toBeNull();
    expect(document.getElementById('ala-test-ed-stubborn')).not.toBeNull();
    expect(document.getElementById('ala-test-editor-close-style')).not.toBeNull();
    expect(document.getElementById('ala-test-editor-esc-style')).not.toBeNull();
    expect(document.getElementById('ala-test-editor-stubborn-style')).not.toBeNull();

    const removeListenerSpy = vi.spyOn(document, 'removeEventListener');
    closePanel();

    expect(document.getElementById('ala-settings-backdrop')).toBeNull();
    expect(document.getElementById('ala-test-ed-close')).toBeNull();
    expect(document.getElementById('ala-test-ed-esc')).toBeNull();
    expect(document.getElementById('ala-test-ed-stubborn')).toBeNull();
    expect(document.getElementById('ala-test-editor-close-style')).toBeNull();
    expect(document.getElementById('ala-test-editor-esc-style')).toBeNull();
    expect(document.getElementById('ala-test-editor-stubborn-style')).toBeNull();
    expect(removeListenerSpy.mock.calls.filter((c) => c[0] === 'keydown' && c[2] === true).length).toBeGreaterThanOrEqual(2);

    expect(() => (window as any).__lastEditorCtxA.onApply({ updated: true })).not.toThrow();
    expect(Settings.get('panelEditorCloseBtn')).toEqual({});
  });

  it('clears pending import reload timer and ignores post-await updates when panel closes mid-import', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const readSpy = vi.spyOn(backup, 'readFileAsBytes').mockResolvedValue(new Uint8Array([1, 2, 3]));
    const importSpy = vi.spyOn(backup, 'importBackup').mockResolvedValue({ applied: 2, secretsApplied: 0 });
    showPanel();

    const fileInput = document.querySelector<HTMLInputElement>('#ala-import-file')!;
    const mockFile = new File(['{}'], 'backup.settings', { type: 'application/json' });
    Object.defineProperty(fileInput, 'files', { value: [mockFile], configurable: true });

    fileInput.dispatchEvent(new Event('change'));
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(importSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    clearTimeoutSpy.mockClear();
    closePanel();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(errSpy).not.toHaveBeenCalled();

    let resolveBytes!: (b: Uint8Array) => void;
    readSpy.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveBytes = res;
        })
    );
    importSpy.mockClear();

    showPanel();
    const fileInput2 = document.querySelector<HTMLInputElement>('#ala-import-file')!;
    Object.defineProperty(fileInput2, 'files', { value: [mockFile], configurable: true });
    fileInput2.dispatchEvent(new Event('change'));
    closePanel();

    resolveBytes(new Uint8Array([4, 5]));
    await Promise.resolve();
    await Promise.resolve();

    expect(importSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('cancels encrypted import password modal cleanly when closePanel() runs mid-import', async () => {
    const encryptedBytes = await backup.createBackup(true, 'secret-pass');
    vi.spyOn(backup, 'readFileAsBytes').mockResolvedValue(encryptedBytes);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    showPanel();
    const fileInput = document.querySelector<HTMLInputElement>('#ala-import-file')!;
    const mockFile = new File([encryptedBytes as unknown as BlobPart], 'backup.settings', {
      type: 'application/octet-stream'
    });
    Object.defineProperty(fileInput, 'files', { value: [mockFile], configurable: true });
    fileInput.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();
    });

    setTimeoutSpy.mockClear();
    closePanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
    expect(document.getElementById('ala-settings-backdrop')).toBeNull();
    expect(setTimeoutSpy.mock.calls.filter((c) => c[1] === 600)).toHaveLength(0);
  });

  it('normalizes number and list inputs in getPanelOverrides() during export', async () => {
    Settings.set('devModeEnabled', true);
    const rawSpy = vi.spyOn(backup, 'createRawBackup');
    const createSpy = vi.spyOn(backup, 'createBackup').mockResolvedValue(new Uint8Array([1]));
    const dlSpy = vi.spyOn(backup, 'downloadBackupFile').mockImplementation(() => {});

    showPanel();

    const numInput = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="panelTestNumber"]')!;
    const listInput = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="panelTestList"]')!;

    numInput.value = '250';
    listInput.value = ' SubsPlease , , Erai-raws , Judged ';

    document.querySelector<HTMLButtonElement>('#ala-btn-export-raw')!.click();
    expect(rawSpy).toHaveBeenCalledTimes(1);
    const rawOverrides = rawSpy.mock.calls[0][0]!;
    expect(rawOverrides.panelTestNumber).toBe(100);
    expect(rawOverrides.panelTestList).toEqual(['SubsPlease', 'Erai-raws', 'Judged']);
    expect(dlSpy).toHaveBeenCalledTimes(1);

    numInput.value = '42';
    listInput.value = 'GroupOne, GroupTwo';
    document.querySelector<HTMLButtonElement>('#ala-btn-export')!.click();
    document.querySelector<HTMLButtonElement>('#ala-pwd-btn-submit')!.click();

    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const exportOverrides = createSpy.mock.calls[0][2]!;
    expect(exportOverrides.panelTestNumber).toBe(42);
    expect(exportOverrides.panelTestList).toEqual(['GroupOne', 'GroupTwo']);
  });

  it('updates only baseline.statuses when async probeStandalone resolves true, keeping Save at "Save" without losing edits', async () => {
    Settings.set('panelStandaloneEnabled', true);
    Settings.set('panelDependentEnabled', true);
    Settings.set('panelOptionsEnabled', true);
    standaloneProbeResult = true;

    const host = createModuleHost();
    showPanel(host);

    const saveBtn = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;
    const numInput = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="panelTestNumber"]')!;

    expect(saveBtn.textContent).toBe('Save');

    numInput.value = '88';
    numInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(saveBtn.textContent).toBe('Save');

    await vi.waitFor(() => {
      expect(document.querySelector('[data-feature="panelStandaloneMod"] .ala-standalone-note')?.textContent).toContain(
        'Standalone Tool'
      );
    });

    expect(document.querySelector('[data-feature="panelDependentMod"] .ala-dep-note')?.textContent).toContain(
      'Standalone Test Feature'
    );

    expect(saveBtn.textContent).toBe('Save');

    const hostReloadSpy = vi.spyOn(host, 'reload');
    saveBtn.click();
    expect(Settings.get('panelTestNumber')).toBe(88);
    expect(hostReloadSpy).toHaveBeenCalledWith(['panelOptionsMod']);
    expect(document.querySelector('#ala-settings-panel .ala-status')?.textContent).toBe('Saved and applied.');

    closePanel();

    let statusCb: ((id: string, status: any) => void) | undefined;
    const mockHost = {
      reload: vi.fn(),
      getStatus: () => ({ active: true }),
      resolveStagedStates: (staged: Record<string, boolean>) => {
        const out: Record<string, any> = {};
        for (const [id, on] of Object.entries(staged)) {
          out[id] = { active: !!on, reason: on ? undefined : 'disabled' };
        }
        return out;
      },
      onStatusChange: (cb: (id: string, status: any) => void) => {
        statusCb = cb;
        return () => {
          statusCb = undefined;
        };
      },
      probeStandalone: async () => false
    };

    showPanel(mockHost);
    await Promise.resolve();
    const saveBtn2 = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;
    expect(saveBtn2.textContent).toBe('Save');

    statusCb?.('panelStandaloneMod', { active: false, reason: 'standalone-paused' });
    expect(document.querySelector('[data-feature="panelStandaloneMod"] .ala-standalone-note')?.textContent).toContain(
      'Standalone Tool'
    );
    expect(saveBtn2.textContent).toBe('Save');
    saveBtn2.click();
    expect(document.querySelector('#ala-settings-panel .ala-status')?.textContent).toBe('Saved.');
  });

  it('handles document.body === null safely in ensureLauncher(), installSidebar(), and showPanel()', () => {
    const origBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      expect(() => ensureLauncher()).not.toThrow();
      expect(() => installSidebar()).not.toThrow();
      expect(() => showPanel()).not.toThrow();
      expect(document.getElementById('ala-settings-mobile-launcher')).toBeNull();
      expect(document.getElementById('ala-settings-nav-section')).toBeNull();
      expect(document.getElementById('ala-settings-backdrop')).toBeNull();
    } finally {
      delete (document as any).body;
      if (!document.body && origBody) document.documentElement.appendChild(origBody);
    }
  });

  it('unlocks standalone-paused module when probeStandalone resolves false without false Save and reload or dep-off locks (B2-01)', async () => {
    Settings.set('panelStandaloneEnabled', true);
    Settings.set('panelDependentEnabled', true);
    Settings.set('panelOptionsEnabled', true);
    Settings.set('panelTestNumber', 25);

    standaloneProbeResult = true;
    const host = createModuleHost();
    await host.probeStandalone('panelStandaloneMod');
    standaloneProbeResult = false;

    showPanel(host);

    const standaloneToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelStandaloneEnabled"]'
    )!;
    const depToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelDependentEnabled"]'
    )!;
    const numInput = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelTestNumber"]'
    )!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;

    expect(standaloneToggle.dataset.standaloneLocked).toBe('1');
    expect(standaloneToggle.checked).toBe(false);
    expect(standaloneToggle.disabled).toBe(true);
    expect(depToggle.disabled).toBe(true);
    expect(document.querySelector('[data-feature="panelDependentMod"] .ala-dep-note')?.textContent).toContain(
      'Standalone Test Feature'
    );
    expect(saveBtn.textContent).toBe('Save');

    numInput.value = '77';
    numInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(saveBtn.textContent).toBe('Save');

    await vi.waitFor(() => {
      expect(document.querySelector('[data-feature="panelStandaloneMod"] .ala-standalone-note')).toBeNull();
    });

    expect(standaloneToggle.dataset.standaloneLocked).toBeUndefined();
    expect(standaloneToggle.checked).toBe(true);
    expect(standaloneToggle.disabled).toBe(false);
    expect(depToggle.disabled).toBe(false);
    expect(depToggle.checked).toBe(true);
    expect(document.querySelector('[data-feature="panelDependentMod"] .ala-dep-note')).toBeNull();
    expect(saveBtn.textContent).toBe('Save');
    expect(numInput.value).toBe('77');

    const hostReloadSpy = vi.spyOn(host, 'reload');
    saveBtn.click();
    expect(Settings.get('panelTestNumber')).toBe(77);
    expect(Settings.get('panelStandaloneEnabled')).toBe(true);
    expect(hostReloadSpy).toHaveBeenCalledWith(['panelOptionsMod']);
    expect(document.querySelector('#ala-settings-panel .ala-status')?.textContent).toBe('Saved and applied.');
  });

  it('unlocks standalone-paused module on active status event without clobbering manual edits (B2-01)', () => {
    Settings.set('panelStandaloneEnabled', true);
    Settings.set('panelDependentEnabled', true);
    Settings.set('panelOptionsEnabled', true);

    let statusCb: ((id: string, status: any) => void) | undefined;
    const mockHost = {
      reload: vi.fn(),
      getStatus: (id: string) => {
        if (id === 'panelStandaloneMod') return { active: false, reason: 'standalone-paused' as const };
        if (id === 'panelDependentMod') {
          return { active: false, reason: 'dep-off' as const, disabledDeps: ['panelStandaloneMod'] };
        }
        return { active: true };
      },
      resolveStagedStates: (staged: Record<string, boolean>) => {
        const out: Record<string, any> = {};
        for (const [id, on] of Object.entries(staged)) {
          if (id === 'panelDependentMod' && on && !staged['panelStandaloneMod']) {
            out[id] = { active: false, reason: 'dep-off', disabledDeps: ['panelStandaloneMod'] };
          } else {
            out[id] = { active: !!on, reason: on ? undefined : 'disabled' };
          }
        }
        return out;
      },
      onStatusChange: (cb: (id: string, status: any) => void) => {
        statusCb = cb;
        return () => {
          statusCb = undefined;
        };
      },
      probeStandalone: () => new Promise<boolean>(() => {})
    };

    showPanel(mockHost);

    const standaloneToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelStandaloneEnabled"]'
    )!;
    const depToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelDependentEnabled"]'
    )!;
    const optionsToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelOptionsEnabled"]'
    )!;
    const numInput = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelTestNumber"]'
    )!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;

    expect(standaloneToggle.dataset.standaloneLocked).toBe('1');
    expect(depToggle.disabled).toBe(true);

    optionsToggle.checked = false;
    optionsToggle.dispatchEvent(new Event('change', { bubbles: true }));
    numInput.value = '64';
    numInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(saveBtn.textContent).toBe('Save');

    statusCb?.('panelStandaloneMod', { active: true });

    expect(standaloneToggle.dataset.standaloneLocked).toBeUndefined();
    expect(standaloneToggle.checked).toBe(true);
    expect(standaloneToggle.disabled).toBe(false);
    expect(document.querySelector('[data-feature="panelStandaloneMod"] .ala-standalone-note')).toBeNull();
    expect(depToggle.disabled).toBe(false);
    expect(document.querySelector('[data-feature="panelDependentMod"] .ala-dep-note')).toBeNull();
    expect(saveBtn.textContent).toBe('Save');

    expect(optionsToggle.checked).toBe(false);
    expect(numInput.value).toBe('64');

    saveBtn.click();
    expect(Settings.get('panelOptionsEnabled')).toBe(false);
    expect(Settings.get('panelTestNumber')).toBe(64);
    expect(Settings.get('panelStandaloneEnabled')).toBe(true);
    expect(mockHost.reload).toHaveBeenCalledWith(['panelOptionsMod']);
    expect(document.querySelector('#ala-settings-panel .ala-status')?.textContent).toBe('Saved and applied.');
  });

  it('cancels Save and reload 350ms timer on closePanel() and SPA navigation without reloading (B2-02)', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    showPanel();
    const standaloneToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelStandaloneEnabled"]'
    )!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;

    standaloneToggle.checked = true;
    standaloneToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(saveBtn.textContent).toBe('Save and reload');

    saveBtn.click();
    expect(Settings.get('panelStandaloneEnabled')).toBe(true);
    expect(document.querySelector('#ala-settings-panel .ala-status')?.textContent).toBe('Saved. Reloading…');
    expect(setTimeoutSpy.mock.calls.some((c) => c[1] === 350)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    clearTimeoutSpy.mockClear();
    closePanel();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(errSpy).not.toHaveBeenCalled();

    Settings.set('panelStandaloneEnabled', false);
    const cleanupSettingsPage = initSettingsPage();
    vi.advanceTimersByTime(150);
    try {
      showPanel();
      const standaloneToggle2 = document.querySelector<HTMLInputElement>(
        '#ala-settings-panel input[data-key="panelStandaloneEnabled"]'
      )!;
      const saveBtn2 = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;
      standaloneToggle2.checked = true;
      standaloneToggle2.dispatchEvent(new Event('change', { bubbles: true }));
      expect(saveBtn2.textContent).toBe('Save and reload');

      // initSettingsPage() subscribes to Core.onNavigate, which lazily starts the 400ms observer poll interval
      const navBaselineTimers = vi.getTimerCount();
      clearTimeoutSpy.mockClear();
      saveBtn2.click();
      expect(saveBtn2.disabled).toBe(true);
      saveBtn2.click();
      expect(clearTimeoutSpy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(navBaselineTimers + 1);

      history.pushState({}, '', '/home');
      expect(document.getElementById('ala-settings-backdrop')).toBeNull();
      expect(vi.getTimerCount()).toBe(navBaselineTimers);
      vi.advanceTimersByTime(1000);
      expect(errSpy).not.toHaveBeenCalled();

      history.replaceState({}, '', '/settings');
      vi.advanceTimersByTime(150);
      Settings.set('panelStandaloneEnabled', false);
      showPanel();
      const standaloneToggle3 = document.querySelector<HTMLInputElement>(
        '#ala-settings-panel input[data-key="panelStandaloneEnabled"]'
      )!;
      const saveBtn3 = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;
      standaloneToggle3.checked = true;
      standaloneToggle3.dispatchEvent(new Event('change', { bubbles: true }));
      saveBtn3.click();
      expect(vi.getTimerCount()).toBe(navBaselineTimers + 1);
      document.getElementById('ala-settings-panel')?.remove();
      vi.advanceTimersByTime(350);
      expect(vi.getTimerCount()).toBe(navBaselineTimers);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      cleanupSettingsPage();
      closePanel();
      history.replaceState({}, '', '/settings');
      vi.advanceTimersByTime(150);
      document.getElementById('ala-settings-mobile-launcher')?.remove();
      document.getElementById('ala-settings-style')?.remove();
    }
  });

  it('normalizes empty and whitespace modal IDs in JsonEditorContext.modal() (BUG-85)', () => {
    showPanel();
    document.querySelector<HTMLButtonElement>('#ala-btn-edit-panelEditorCloseBtn')!.click();
    const ec = (window as any).__lastEditorCtxA;
    expect(ec).toBeDefined();

    const mEmpty = ec.modal({ id: '', title: 'Empty Editor Modal' });
    const mSpaces = ec.modal({ id: '   ', title: 'Whitespace Editor Modal' });
    try {
      expect(mEmpty.backdrop.id).toBe('ala-editor-panelEditorCloseBtn-modal-1');
      expect(mSpaces.backdrop.id).toBe('ala-editor-panelEditorCloseBtn-modal-2');
    } finally {
      mEmpty.close();
      mSpaces.close();
    }
  });

  it('synchronizes details.open, aria-expanded, .is-expanded, and .is-open on initial render and toggle (BUG-41)', () => {
    showPanel();
    const dropdowns = Array.from(document.querySelectorAll<HTMLDetailsElement>('#ala-settings-panel details.ala-section-dropdown'));
    expect(dropdowns.length).toBeGreaterThanOrEqual(3);

    for (const details of dropdowns) {
      const summary = details.querySelector<HTMLElement>(':scope > summary')!;
      const collapsible = details.querySelector<HTMLElement>(':scope > .ala-collapsible')!;
      expect(details.open).toBe(false);
      expect(details.hasAttribute('open')).toBe(false);
      expect(details.classList.contains('is-expanded')).toBe(false);
      expect(collapsible.classList.contains('is-open')).toBe(false);
      expect(summary.getAttribute('aria-expanded')).toBe('false');
    }

    const first = dropdowns[0];
    const firstSummary = first.querySelector<HTMLElement>(':scope > summary')!;
    const firstCollapsible = first.querySelector<HTMLElement>(':scope > .ala-collapsible')!;

    firstSummary.click();
    expect(first.open).toBe(true);
    expect(first.classList.contains('is-expanded')).toBe(true);
    expect(firstCollapsible.classList.contains('is-open')).toBe(true);
    expect(firstSummary.getAttribute('aria-expanded')).toBe('true');

    firstSummary.click();
    expect(first.open).toBe(false);
    expect(first.classList.contains('is-expanded')).toBe(false);
    expect(firstCollapsible.classList.contains('is-open')).toBe(false);
    expect(firstSummary.getAttribute('aria-expanded')).toBe('false');

    const origGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      if (el === firstCollapsible) {
        return { transitionDuration: '0.22s, 0s' } as CSSStyleDeclaration;
      }
      return origGetComputedStyle(el);
    });

    firstSummary.click();
    expect(first.open).toBe(true);
    firstSummary.click();
    expect(first.classList.contains('is-expanded')).toBe(false);
    expect(firstCollapsible.classList.contains('is-open')).toBe(false);
    expect(firstSummary.getAttribute('aria-expanded')).toBe('false');
    expect(first.open).toBe(true);

    const te = new Event('transitionend', { bubbles: true }) as Event & { propertyName?: string };
    te.propertyName = 'grid-template-rows';
    firstCollapsible.dispatchEvent(te);
    expect(first.open).toBe(false);
  });

  it('sets Save and reload when a hot-reloadable module change cascades into a requiresReload dependent (BUG-42)', () => {
    Settings.set('panelHotBaseEnabled', true);
    Settings.set('panelHotMidEnabled', true);
    Settings.set('panelReloadDepEnabled', true);

    const mockHost = {
      reload: vi.fn(),
      getStatus: () => ({ active: true }),
      resolveStagedStates: (staged: Record<string, boolean>) => {
        const out: Record<string, any> = {};
        for (const [id, on] of Object.entries(staged)) {
          out[id] = { active: !!on, reason: on ? undefined : 'disabled' };
        }
        if (out.panelHotMidMod?.active && !out.panelHotBaseMod?.active) {
          out.panelHotMidMod = { active: false, reason: 'dep-off', disabledDeps: ['panelHotBaseMod'] };
        }
        if (out.panelReloadDepMod?.active && !out.panelHotMidMod?.active) {
          out.panelReloadDepMod = { active: false, reason: 'dep-off', disabledDeps: ['panelHotMidMod'] };
        }
        return out;
      },
      onStatusChange: () => () => {},
      probeStandalone: async () => false
    };

    showPanel(mockHost);
    const saveBtn = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;
    const numInput = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="panelHotBaseNum"]')!;
    expect(saveBtn.textContent).toBe('Save');

    numInput.value = '25';
    numInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(saveBtn.textContent).toBe('Save and reload');

    const reloadDepToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelReloadDepEnabled"]'
    )!;
    reloadDepToggle.checked = false;
    reloadDepToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(saveBtn.textContent).toBe('Save and reload');

    closePanel();
    Settings.set('panelReloadDepEnabled', false);
    showPanel(mockHost);
    const saveBtn2 = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;
    const numInput2 = document.querySelector<HTMLInputElement>('#ala-settings-panel input[data-key="panelHotBaseNum"]')!;
    numInput2.value = '30';
    numInput2.dispatchEvent(new Event('change', { bubbles: true }));
    expect(saveBtn2.textContent).toBe('Save');
    saveBtn2.click();
    expect(mockHost.reload).toHaveBeenCalledWith(['panelHotBaseMod']);
  });

  it('treats crashed modules (reason === "error") as inactive in baseline and propagates dep-unavailable without prompting Save and reload (BUG-43)', () => {
    vi.useFakeTimers();
    Settings.set('panelStandaloneEnabled', true);
    Settings.set('panelDependentEnabled', true);

    const mockHost = {
      reload: vi.fn(),
      getStatus: (id: string) => {
        if (id === 'panelStandaloneMod') {
          return { active: false, reason: 'error' as const, error: 'Init failed' };
        }
        if (id === 'panelDependentMod') {
          return { active: false, reason: 'dep-unavailable' as const, missingDeps: ['panelStandaloneMod'] };
        }
        return { active: false, reason: 'disabled' as const };
      },
      resolveStagedStates: (staged: Record<string, boolean>) => {
        const out: Record<string, any> = {};
        for (const [id, on] of Object.entries(staged)) {
          out[id] = { active: !!on, reason: on ? undefined : 'disabled' };
        }
        if (out.panelDependentMod?.active && !out.panelStandaloneMod?.active) {
          out.panelDependentMod = { active: false, reason: 'dep-off', disabledDeps: ['panelStandaloneMod'] };
        }
        return out;
      },
      onStatusChange: () => () => {},
      probeStandalone: () => new Promise<boolean>(() => {})
    };

    showPanel(mockHost);
    const saveBtn = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;
    const crashedToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelStandaloneEnabled"]'
    )!;
    const depToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelDependentEnabled"]'
    )!;

    expect(saveBtn.textContent).toBe('Save');
    expect(document.querySelector('[data-feature="panelStandaloneMod"] .ala-badge--error')?.textContent).toBe('Error');
    expect(document.querySelector('[data-feature="panelDependentMod"] .ala-dep-note')?.textContent).toContain(
      'panelStandaloneMod'
    );
    expect(depToggle.disabled).toBe(true);

    crashedToggle.checked = false;
    crashedToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(saveBtn.textContent).toBe('Save');

    saveBtn.click();
    expect(Settings.get('panelStandaloneEnabled')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector('#ala-settings-panel .ala-status')?.textContent).toBe('Saved.');
  });

  it('disposes per-session JSON editor resources on ec.modal() close and cleans up async overlays on closePanel() (BUG-44)', async () => {
    vi.useFakeTimers();
    showPanel();

    const editBtn = document.querySelector<HTMLButtonElement>('#ala-btn-edit-panelEditorModalSession')!;
    editBtn.click();

    expect(document.getElementById('ala-test-editor-session-style')).not.toBeNull();
    expect(document.getElementById('ala-editor-panelEditorModalSession-session-modal')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect((window as any).__modalEditorTracker.keydownCalls).toBe(1);

    expect((window as any).__modalEditorTracker.ctx.signal.aborted).toBe(false);
    expect((window as any).__modalEditorTracker.onCleanupCalls).toBe(0);

    document
      .querySelector<HTMLButtonElement>('#ala-editor-panelEditorModalSession-session-modal .ala-core-close')!
      .click();

    expect(document.getElementById('ala-editor-panelEditorModalSession-session-modal')).toBeNull();
    expect(document.getElementById('ala-test-editor-session-style')).toBeNull();
    expect(document.getElementById('ala-settings-backdrop')).not.toBeNull();
    expect((window as any).__modalEditorTracker.ctx.signal.aborted).toBe(true);
    expect((window as any).__modalEditorTracker.onCleanupCalls).toBe(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    expect((window as any).__modalEditorTracker.keydownCalls).toBe(1);

    vi.advanceTimersByTime(6000);
    expect((window as any).__modalEditorTracker.timerFired).toBe(false);

    document.querySelector<HTMLButtonElement>('#ala-btn-edit-panelEditorAsyncOverlay')!.click();
    await Promise.resolve();
    expect(document.getElementById('ala-test-ed-async-overlay')).not.toBeNull();

    closePanel();
    expect(document.getElementById('ala-test-ed-async-overlay')).toBeNull();
  });

  it('keeps JsonEditorContext session alive across duplicate modal replacement and aborts ec.signal on closePanel() (IMP-02 & IMP-09)', () => {
    showPanel();
    document.querySelector<HTMLButtonElement>('#ala-btn-edit-panelEditorCloseBtn')!.click();
    const ec = (window as any).__lastEditorCtxA;
    expect(ec.signal.aborted).toBe(false);

    const sessionCleanup = vi.fn();
    ec.onCleanup(sessionCleanup);

    const m1 = ec.modal({ id: 'dup-ed-modal', title: 'First' });
    const m2 = ec.modal({ id: 'dup-ed-modal', title: 'Second' });
    expect(m1.signal.aborted).toBe(true);
    expect(m2.signal.aborted).toBe(false);
    expect(ec.signal.aborted).toBe(false);
    expect(sessionCleanup).not.toHaveBeenCalled();

    closePanel();
    expect(ec.signal.aborted).toBe(true);
    expect(m2.signal.aborted).toBe(true);
    expect(sessionCleanup).toHaveBeenCalledTimes(1);

    const lateCleanup = vi.fn();
    ec.onCleanup(lateCleanup);
    expect(lateCleanup).toHaveBeenCalledTimes(1);
    expect(ec.modal({ id: 'after-close', title: 'After' }).signal.aborted).toBe(true);
  });

  it('clears .is-active from sidebar link on closePanel() and removes #ala-settings-nav-section on navigation away (BUG-45)', () => {
    vi.useFakeTimers();
    const sidebarWrap = document.createElement('div');
    sidebarWrap.innerHTML = '<div><div>Profile</div><div>Developer</div></div>';
    document.body.appendChild(sidebarWrap);

    let cleanupSettingsPage: (() => void) | undefined;
    try {
      cleanupSettingsPage = initSettingsPage();
      vi.advanceTimersByTime(150);

      const navSection = document.getElementById('ala-settings-nav-section');
      const launcher = document.getElementById('ala-settings-mobile-launcher');
      expect(navSection).not.toBeNull();
      expect(launcher).not.toBeNull();

      const navLink = navSection!.querySelector<HTMLAnchorElement>('.ala-settings-nav-link')!;
      navLink.click();
      expect(navLink.classList.contains('is-active')).toBe(true);
      expect(document.getElementById('ala-settings-backdrop')).not.toBeNull();

      closePanel();
      expect(navLink.classList.contains('is-active')).toBe(false);

      navLink.click();
      expect(navLink.classList.contains('is-active')).toBe(true);
      history.pushState({}, '', '/home');

      expect(document.getElementById('ala-settings-backdrop')).toBeNull();
      expect(document.getElementById('ala-settings-nav-section')).toBeNull();
      expect(document.getElementById('ala-settings-mobile-launcher')).toBeNull();
    } finally {
      cleanupSettingsPage?.();
      closePanel();
      history.replaceState({}, '', '/settings');
      vi.advanceTimersByTime(150);
      sidebarWrap.remove();
      document.getElementById('ala-settings-nav-section')?.remove();
      document.getElementById('ala-settings-mobile-launcher')?.remove();
      document.getElementById('ala-settings-style')?.remove();
    }
  });
});

describe('Settings Panel Batch 11 Improvements (IMP-10 & IMP-14)', () => {
  beforeEach(() => {
    ensureTestModulesRegistered();
    standaloneProbeResult = false;
    Settings.set('panelStandaloneEnabled', false);
    Settings.set('panelDependentEnabled', false);
    Settings.set('panelOptionsEnabled', false);
    history.replaceState({}, '', '/settings');
  });

  afterEach(() => {
    closePanel();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('replaces blocking confirm/alert in panel.ts with non-blocking openConfirmModal, guards re-entrant clicks, and disposes ec.confirm/alert/toast (IMP-10)', async () => {
    let connected = true;
    const disconnectSpy = vi.fn(() => {
      connected = false;
    });
    const unregAcc = registerAccountProvider({
      id: 'panelAccTest',
      name: 'PanelAcc',
      secretKeys: [],
      isConnected: () => connected,
      connect: vi.fn(),
      disconnect: disconnectSpy
    });
    const nativeConfirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm must not be called');
    });

    try {
      showPanel();

      const accBtn = document.querySelector<HTMLButtonElement>('[data-account-btn="panelAccTest"]')!;
      accBtn.click();
      expect(accBtn.disabled).toBe(true);
      accBtn.click(); // re-entrant click ignored

      const modalsAfterClick = document.querySelectorAll('.ala-core-backdrop');
      expect(modalsAfterClick).toHaveLength(1);
      modalsAfterClick[0].querySelector<HTMLButtonElement>('.ala-core-confirm-cancel')!.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(disconnectSpy).not.toHaveBeenCalled();
      expect(accBtn.disabled).toBe(false);

      accBtn.click();
      document.querySelector<HTMLButtonElement>('.ala-core-confirm-ok')!.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      expect(nativeConfirmSpy).not.toHaveBeenCalled();

      // Export with Secrets: re-entrancy guard + closePanel() auto-dismisses pending confirm
      const expSecretsBtn = document.querySelector<HTMLButtonElement>('#ala-btn-export-secrets')!;
      expSecretsBtn.click();
      expect(expSecretsBtn.disabled).toBe(true);
      expect(document.querySelectorAll('.ala-core-backdrop')).toHaveLength(1);
      closePanel();
      await Promise.resolve();
      expect(document.querySelectorAll('.ala-core-backdrop')).toHaveLength(0);

      // JsonEditorContext ec.confirm, ec.alert, and disposal-guarded ec.toast
      showPanel();
      document.querySelector<HTMLButtonElement>('#ala-btn-edit-panelEditorCloseBtn')!.click();
      const ec = (window as any).__lastEditorCtxA;
      expect(typeof ec.confirm).toBe('function');
      expect(typeof ec.alert).toBe('function');
      expect(typeof ec.toast?.show).toBe('function');

      const ecConfirmP = ec.confirm({ id: 'ec-confirm-1', message: 'Confirm in editor?' });
      expect(document.getElementById('ala-editor-panelEditorCloseBtn-ec-confirm-1')).not.toBeNull();
      closePanel();
      await expect(ecConfirmP).resolves.toBe(false);
      await expect(ec.alert({ id: 'ec-alert-after', message: 'After close' })).resolves.toBeUndefined();
      expect(document.getElementById('ala-editor-panelEditorCloseBtn-ec-alert-after')).toBeNull();

      ec.toast.success('should be ignored after close');
      expect(document.getElementById('ala-toast')).toBeNull();
    } finally {
      unregAcc();
    }
  });

  it('auto-enables parent toggle via generic autoEnableParentWhenNonEmpty flag for non-empty arrays/objects and respects disabled parent (IMP-14)', async () => {
    let capturedOnApply!: (v: any) => void;
    let standaloneLocked = false;

    defineModule({
      id: 'autoParentMod',
      key: 'autoParentEnabled',
      section: 'PanelTests',
      title: 'Auto Parent Feature',
      help: 'Generic auto-enable test',
      standalone: {
        name: 'Standalone AutoParent',
        probe: () => standaloneLocked
      },
      options: [
        {
          key: 'genericAutoEnableOpt',
          type: 'json',
          def: {},
          autoEnableParentWhenNonEmpty: true,
          title: 'Generic Structured Option',
          help: 'Uses autoEnableParentWhenNonEmpty',
          editor(ec) {
            capturedOnApply = ec.onApply;
          }
        }
      ],
      setup: () => {}
    });

    Settings.set('autoParentEnabled', false);
    Settings.set('genericAutoEnableOpt', {});

    const host = createModuleHost();
    showPanel(host);
    await Promise.resolve();

    const card = document.querySelector<HTMLElement>('.ala-feature[data-feature="autoParentMod"]')!;
    const mainToggle = card.querySelector<HTMLInputElement>('.ala-row--main input[type="checkbox"][data-key]')!;
    const editBtn = document.querySelector<HTMLButtonElement>('#ala-btn-edit-genericAutoEnableOpt')!;
    editBtn.click();

    // Empty object / empty array do not auto-enable
    capturedOnApply({});
    expect(mainToggle.checked).toBe(false);
    expect(card.classList.contains('is-off')).toBe(true);

    capturedOnApply([]);
    expect(mainToggle.checked).toBe(false);
    expect(card.classList.contains('is-off')).toBe(true);

    // Non-empty plain object auto-enables and syncs card state
    capturedOnApply({ item: 1 });
    expect(mainToggle.checked).toBe(true);
    expect(card.classList.contains('is-off')).toBe(false);

    // Reset and verify non-empty array also auto-enables
    mainToggle.checked = false;
    mainToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(card.classList.contains('is-off')).toBe(true);
    capturedOnApply(['entry']);
    expect(mainToggle.checked).toBe(true);
    expect(card.classList.contains('is-off')).toBe(false);

    // Disabled mainToggle (e.g., standalone-paused) must stay unchecked & disabled
    closePanel();
    standaloneLocked = true;
    Settings.set('autoParentEnabled', true);
    await host.probeStandalone('autoParentMod');
    showPanel(host);
    await Promise.resolve();

    const lockedCard = document.querySelector<HTMLElement>('.ala-feature[data-feature="autoParentMod"]')!;
    const lockedToggle = lockedCard.querySelector<HTMLInputElement>(
      '.ala-row--main input[type="checkbox"][data-key]'
    )!;
    expect(lockedToggle.disabled).toBe(true);
    expect(lockedToggle.checked).toBe(false);

    document.querySelector<HTMLButtonElement>('#ala-btn-edit-genericAutoEnableOpt')!.click();
    capturedOnApply({ item: 2 });
    expect(lockedToggle.checked).toBe(false);
  });
});

describe('Settings Panel Cycle 2 Fixes (BUG-18, BUG-19, BUG-20)', () => {
  let bugTestsRegistered = false;
  let editorCleanups: Array<() => void> = [];
  let editorContexts: any[] = [];
  let asyncStepResolver: (() => void) | null = null;
  let throwingEditorSpy: ReturnType<typeof vi.fn<() => void>>;
  let normalizedApplyFn: ((v: any) => void) | null = null;

  beforeEach(() => {
    ensureTestModulesRegistered();
    if (!bugTestsRegistered) {
      bugTestsRegistered = true;
      defineModule({
        id: 'panelBug1819Mod',
        key: 'panelBug1819Enabled',
        section: 'PanelTests',
        title: 'Cycle 2 Panel Test Feature',
        help: 'Covers BUG-18 and BUG-19',
        options: [
          {
            key: 'bug18NormalizedOpt',
            type: 'json',
            def: {},
            autoEnableParentWhenNonEmpty: true,
            title: 'Normalized Auto-Enable Option',
            help: 'Strips invalid keys during validate',
            validate(v: any) {
              if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
              const out: Record<string, any> = {};
              if (typeof v.keep === 'number') out.keep = v.keep;
              return { valid: true, value: out };
            },
            editor(ec) {
              normalizedApplyFn = ec.onApply;
              editorContexts.push(ec);
              ec.addStyle('ala-bug18-norm-style', '.ala-bug18-norm { color: red; }');
              ec.onCleanup(() => editorCleanups.push(() => {}));
            }
          },
          {
            key: 'bug19ConfirmFirstOpt',
            type: 'json',
            def: {},
            title: 'Confirm-First Async Editor',
            help: 'Awaits confirm then opens modal',
            async editor(ec) {
              editorContexts.push(ec);
              ec.addStyle('ala-bug19-async-style', '.ala-bug19-async { color: green; }');
              ec.onCleanup(() => editorCleanups.push(() => {}));
              const ok = await ec.confirm({ id: 'bug19-step1', message: 'Proceed to editor?' });
              if (!ok) return;
              if (asyncStepResolver) {
                await new Promise<void>((res) => {
                  asyncStepResolver = res;
                });
              }
              ec.modal({ id: 'bug19-step2', title: 'Step 2 Modal' });
            }
          },
          {
            key: 'bug19ThrowOpt',
            type: 'json',
            def: {},
            title: 'Throwing Editor',
            help: 'Throws synchronously with zero modals',
            editor(ec) {
              editorContexts.push(ec);
              ec.addStyle('ala-bug19-throw-style', '.ala-bug19-throw { color: blue; }');
              ec.listen(document, 'keydown', throwingEditorSpy);
              ec.onCleanup(() => editorCleanups.push(() => {}));
              throw new Error('editor init boom');
            }
          }
        ],
        setup: () => {}
      });
    }

    standaloneProbeResult = false;
    Settings.set('panelStandaloneEnabled', false);
    Settings.set('panelDependentEnabled', false);
    Settings.set('panelOptionsEnabled', false);
    Settings.set('panelBug1819Enabled', false);
    Settings.set('bug18NormalizedOpt', {});
    editorCleanups = [];
    editorContexts = [];
    asyncStepResolver = null;
    throwingEditorSpy = vi.fn();
    normalizedApplyFn = null;
    document.documentElement.style.overflow = '';
    history.replaceState({}, '', '/settings');
  });

  afterEach(() => {
    closePanel();
    document.getElementById('ala-toast')?.remove();
    document.documentElement.style.overflow = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('updates baseline, disables saveBtn on reload save, and cancels pending reloadTimer on non-reload save (BUG-18)', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    showPanel();
    const standaloneToggle = document.querySelector<HTMLInputElement>(
      '#ala-settings-panel input[data-key="panelStandaloneEnabled"]'
    )!;
    const saveBtn = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;

    standaloneToggle.checked = true;
    standaloneToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(saveBtn.textContent).toBe('Save and reload');

    saveBtn.click();
    expect(saveBtn.disabled).toBe(true);
    expect(saveBtn.textContent).toBe('Save');
    expect(document.querySelector('#ala-settings-panel .ala-status')?.textContent).toBe('Saved. Reloading…');
    expect(vi.getTimerCount()).toBe(1);

    closePanel();
    expect(vi.getTimerCount()).toBe(0);

    // Non-reload save cancels an already-armed reloadTimer (e.g., from import)
    vi.spyOn(backup, 'readFileAsBytes').mockResolvedValue(new Uint8Array([1, 2]));
    vi.spyOn(backup, 'importBackup').mockResolvedValue({ applied: 1, secretsApplied: 0 });

    showPanel();
    const fileInput = document.querySelector<HTMLInputElement>('#ala-import-file')!;
    const mockFile = new File(['{}'], 'backup.settings', { type: 'application/json' });
    Object.defineProperty(fileInput, 'files', { value: [mockFile], configurable: true });
    fileInput.dispatchEvent(new Event('change'));
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(1);

    const saveBtn2 = document.querySelector<HTMLButtonElement>('#ala-settings-panel .ala-save')!;
    clearTimeoutSpy.mockClear();
    saveBtn2.click();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('disposes prior editor session on re-click, ignores stale onApply, and normalizes before autoEnableParentWhenNonEmpty (BUG-18)', () => {
    showPanel();

    const card = document.querySelector<HTMLElement>('.ala-feature[data-feature="panelBug1819Mod"]')!;
    const mainToggle = card.querySelector<HTMLInputElement>('.ala-row--main input[type="checkbox"][data-key]')!;
    const hiddenInput = card.querySelector<HTMLInputElement>('input[data-key="bug18NormalizedOpt"]')!;
    const editBtn = document.querySelector<HTMLButtonElement>('#ala-btn-edit-bug18NormalizedOpt')!;

    editBtn.click();
    const firstCtx = editorContexts[0];
    const firstApply = normalizedApplyFn!;
    expect(firstCtx.signal.aborted).toBe(false);
    expect(document.getElementById('ala-bug18-norm-style')).not.toBeNull();

    // Non-empty raw payload that normalizes to {} must NOT auto-enable parent toggle
    firstApply({ invalidOnly: true });
    expect(JSON.parse(hiddenInput.value)).toEqual({});
    expect(mainToggle.checked).toBe(false);

    // Valid normalized non-empty payload auto-enables parent toggle
    firstApply({ keep: 42, extra: 'ignored' });
    expect(JSON.parse(hiddenInput.value)).toEqual({ keep: 42 });
    expect(mainToggle.checked).toBe(true);

    // Re-clicking Edit disposes first session while panel remains connected
    editBtn.click();
    const secondCtx = editorContexts[1];
    const secondApply = normalizedApplyFn!;
    expect(firstCtx.signal.aborted).toBe(true);
    expect(editorCleanups).toHaveLength(1);
    expect(secondCtx.signal.aborted).toBe(false);
    expect(document.getElementById('ala-bug18-norm-style')).not.toBeNull();

    // Stale firstApply is ignored even though panel.isConnected is true
    firstApply({ keep: 999 });
    expect(JSON.parse(hiddenInput.value)).toEqual({ keep: 42 });

    // Second session's onApply still works
    secondApply({ keep: 7 });
    expect(JSON.parse(hiddenInput.value)).toEqual({ keep: 7 });
  });

  it('locks #ala-btn-import and #ala-import-file during async import and resets fileInput.value in finally (BUG-18)', async () => {
    let resolveRead!: (bytes: Uint8Array) => void;
    const readSpy = vi.spyOn(backup, 'readFileAsBytes').mockImplementation(
      () =>
        new Promise((res) => {
          resolveRead = res;
        })
    );
    const importSpy = vi.spyOn(backup, 'importBackup').mockResolvedValue({
      applied: 0,
      secretsApplied: 0,
      cancelled: true
    });

    showPanel();
    const importBtn = document.querySelector<HTMLButtonElement>('#ala-btn-import')!;
    const fileInput = document.querySelector<HTMLInputElement>('#ala-import-file')!;
    const mockFile = new File(['{}'], 'backup.settings', { type: 'application/json' });
    Object.defineProperty(fileInput, 'files', { value: [mockFile], configurable: true });
    let clearedValue = 'C:\\fakepath\\backup.settings';
    Object.defineProperty(fileInput, 'value', {
      get: () => clearedValue,
      set: (v: string) => {
        clearedValue = v;
      },
      configurable: true
    });

    fileInput.dispatchEvent(new Event('change'));
    expect(importBtn.disabled).toBe(true);
    expect(fileInput.disabled).toBe(true);

    // Re-entrant click / change ignored while in-flight
    importBtn.click();
    fileInput.dispatchEvent(new Event('change'));
    expect(readSpy).toHaveBeenCalledTimes(1);

    resolveRead(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(importSpy).toHaveBeenCalledTimes(1);
    expect(importBtn.disabled).toBe(false);
    expect(fileInput.disabled).toBe(false);
    expect(fileInput.value).toBe('');
  });

  it('keeps async confirm-first JsonEditorContext alive across modal transitions, cleans up throwing sync editor, and preserves #ala-toast (BUG-19)', async () => {
    vi.useFakeTimers();
    showPanel();

    // 1. Confirm-first -> second modal workflow stays alive between dialogs
    const confirmEditBtn = document.querySelector<HTMLButtonElement>('#ala-btn-edit-bug19ConfirmFirstOpt')!;
    confirmEditBtn.click();

    const asyncEc = editorContexts[0];
    expect(asyncEc.signal.aborted).toBe(false);
    expect(document.getElementById('ala-bug19-async-style')).not.toBeNull();
    expect(document.getElementById('ala-editor-bug19ConfirmFirstOpt-bug19-step1')).not.toBeNull();

    // Confirm step 1 -> activeSessionModals drops to 0 briefly while async editor awaits microtask
    document.querySelector<HTMLButtonElement>('#ala-editor-bug19ConfirmFirstOpt-bug19-step1 .ala-core-confirm-ok')!.click();
    expect(asyncEc.signal.aborted).toBe(false);
    expect(editorCleanups).toHaveLength(0);

    await Promise.resolve();
    await Promise.resolve();
    expect(asyncEc.signal.aborted).toBe(false);
    expect(document.getElementById('ala-editor-bug19ConfirmFirstOpt-bug19-step2')).not.toBeNull();

    // Closing step 2 modal disposes the session synchronously now that editor settled
    document.querySelector<HTMLButtonElement>('#ala-editor-bug19ConfirmFirstOpt-bug19-step2 .ala-core-close')!.click();
    expect(asyncEc.signal.aborted).toBe(true);
    expect(editorCleanups).toHaveLength(1);
    expect(document.getElementById('ala-bug19-async-style')).toBeNull();

    // 2. Synchronous throw with 0 modals disposes session before rethrowing
    const throwEditBtn = document.querySelector<HTMLButtonElement>('#ala-btn-edit-bug19ThrowOpt')!;
    const onErr = vi.fn((e: ErrorEvent) => e.preventDefault());
    window.addEventListener('error', onErr);
    try {
      throwEditBtn.click();
      expect(onErr).toHaveBeenCalledTimes(1);
      expect(onErr.mock.calls[0][0].error?.message).toBe('editor init boom');
    } finally {
      window.removeEventListener('error', onErr);
    }
    const throwEc = editorContexts[1];
    expect(throwEc.signal.aborted).toBe(true);
    expect(editorCleanups).toHaveLength(2);
    expect(document.getElementById('ala-bug19-throw-style')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(throwingEditorSpy).not.toHaveBeenCalled();

    // 3. #ala-toast created during an editor session survives closePanel()
    document.querySelector<HTMLButtonElement>('#ala-btn-edit-bug18NormalizedOpt')!.click();
    const toastEc = editorContexts[2];
    toastEc.toast.success('Kept across closePanel');
    vi.advanceTimersByTime(50);
    expect(document.getElementById('ala-toast')).not.toBeNull();

    closePanel();
    expect(document.getElementById('ala-toast')).not.toBeNull();
  });

  it('coordinates ref-counted acquireScrollLock() across overlapping panel and createModal lifecycles (BUG-20)', () => {
    document.documentElement.style.overflow = 'auto';

    // Direct ref-counting & idempotent release
    const rel1 = acquireScrollLock();
    expect(document.documentElement.style.overflow).toBe('hidden');
    const rel2 = acquireScrollLock();
    expect(document.documentElement.style.overflow).toBe('hidden');
    rel1();
    rel1(); // idempotent
    expect(document.documentElement.style.overflow).toBe('hidden');
    rel2();
    rel2(); // idempotent
    expect(document.documentElement.style.overflow).toBe('auto');

    // Overlapping panel + modal: modal closes first -> overflow stays hidden until panel closes
    document.documentElement.style.overflow = 'scroll';
    showPanel();
    expect(document.documentElement.style.overflow).toBe('hidden');
    const m1 = createModal({ id: 'scroll-overlap-1', title: 'Over Panel 1' });
    expect(document.documentElement.style.overflow).toBe('hidden');
    m1.close();
    expect(document.documentElement.style.overflow).toBe('hidden');
    closePanel();
    expect(document.documentElement.style.overflow).toBe('scroll');

    // Non-LIFO: panel closes first -> overflow stays hidden until modal closes
    showPanel();
    const m2 = createModal({ id: 'scroll-overlap-2', title: 'Over Panel 2' });
    try {
      closePanel();
      expect(document.documentElement.style.overflow).toBe('hidden');
    } finally {
      m2.close();
    }
    expect(document.documentElement.style.overflow).toBe('scroll');

    // Null documentElement safety
    const origDocEl = document.documentElement;
    Object.defineProperty(document, 'documentElement', { value: null, configurable: true });
    try {
      const relNull = acquireScrollLock();
      expect(() => relNull()).not.toThrow();
    } finally {
      Object.defineProperty(document, 'documentElement', { value: origDocEl, configurable: true });
    }
  });

  it('scopes ec.api and ec.observe to JsonEditorContext lifecycle and preserves undefined when host.api is absent (IMP-03 & IMP-04)', async () => {
    showPanel();
    document.querySelector<HTMLButtonElement>('#ala-btn-edit-panelEditorCloseBtn')!.click();
    const ecNoApi = (window as any).__lastEditorCtxA;
    expect(ecNoApi.api).toBeUndefined();
    expect(typeof ecNoApi.observe).toBe('function');

    const obsNode = document.createElement('div');
    document.body.appendChild(obsNode);
    const obsRecords: MutationRecord[][] = [];
    ecNoApi.observe(obsNode, { childList: true }, (records: MutationRecord[]) => {
      obsRecords.push(records);
    });
    obsNode.appendChild(document.createElement('span'));
    await Promise.resolve();
    expect(obsRecords).toHaveLength(1);

    closePanel();
    obsNode.appendChild(document.createElement('b'));
    await Promise.resolve();
    expect(obsRecords).toHaveLength(1);
    obsNode.remove();

    const fakeApi = {
      query: vi.fn((_q: string, _v?: any, opts?: any) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
            { once: true }
          );
        })
      ),
      getMediaList: vi.fn(),
      viewer: vi.fn(),
      clearViewer: vi.fn(),
      invalidate: vi.fn(),
      invalidateMediaList: vi.fn(),
      hasAuth: vi.fn(() => true),
      resumeAt: vi.fn(() => 0),
      media: { get: vi.fn(), save: vi.fn() },
      session: {} as any
    };

    const hostWithApi = {
      api: fakeApi as any,
      reload: vi.fn(),
      getStatus: () => ({ active: false }),
      resolveStagedStates: () => ({}),
      onStatusChange: () => () => {},
      probeStandalone: async () => false
    };

    showPanel(hostWithApi);
    document.querySelector<HTMLButtonElement>('#ala-btn-edit-panelEditorCloseBtn')!.click();
    const ecWithApi = (window as any).__lastEditorCtxA;
    expect(ecWithApi.api).toBeDefined();
    expect(ecWithApi.api).not.toBe(fakeApi);

    const pendingQuery = ecWithApi.api.query('query { Viewer { id } }');
    expect(fakeApi.query).toHaveBeenCalledTimes(1);

    closePanel();
    await expect(pendingQuery).rejects.toMatchObject({ name: 'AbortError' });
    await expect(ecWithApi.api.query('mutation { SaveMediaListEntry(mediaId: 1) { id } }')).rejects.toThrow(
      'Context disposed'
    );
    expect(ecWithApi.api.hasAuth()).toBe(true);
    expect(fakeApi.hasAuth).toHaveBeenLastCalledWith({ reconcile: false });
  });

  it('returns an idempotent CleanupFn from initSettingsPage() that tears down timers, Core hooks, styles, and DOM (IMP-12)', () => {
    vi.useFakeTimers();
    const sidebarWrap = document.createElement('div');
    sidebarWrap.innerHTML = '<div><div>Profile</div><div>Developer</div></div>';
    document.body.appendChild(sidebarWrap);

    try {
      const cleanup = initSettingsPage();
      expect(typeof cleanup).toBe('function');
      expect(document.getElementById('ala-settings-style')).not.toBeNull();

      vi.advanceTimersByTime(150);
      expect(document.getElementById('ala-settings-nav-section')).not.toBeNull();
      expect(document.getElementById('ala-settings-mobile-launcher')).not.toBeNull();

      showPanel();
      expect(document.getElementById('ala-settings-backdrop')).not.toBeNull();

      cleanup();
      cleanup(); // idempotent

      expect(document.getElementById('ala-settings-backdrop')).toBeNull();
      expect(document.getElementById('ala-settings-nav-section')).toBeNull();
      expect(document.getElementById('ala-settings-mobile-launcher')).toBeNull();
      expect(document.getElementById('ala-settings-style')).toBeNull();

      // Core.onBodyMutation and Core.onNavigate no longer re-inject after cleanup
      document.body.appendChild(document.createElement('span'));
      history.pushState({}, '', '/settings/list');
      vi.advanceTimersByTime(200);
      expect(document.getElementById('ala-settings-nav-section')).toBeNull();
      expect(document.getElementById('ala-settings-mobile-launcher')).toBeNull();
    } finally {
      history.replaceState({}, '', '/settings');
      sidebarWrap.remove();
    }
  });
});
