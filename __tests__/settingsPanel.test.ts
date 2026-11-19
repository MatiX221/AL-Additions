import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Settings } from '../src/settings/settings';
import { showPanel, closePanel, ensureLauncher, installSidebar, initSettingsPage } from '../src/settings/panel';
import { defineModule, createModuleHost } from '../src/core/registry';
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
      }
    ],
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
    Settings.set('devModeEnabled', false);
    delete (window as any).__lastEditorCtxA;
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
    initSettingsPage();
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

      clearTimeoutSpy.mockClear();
      saveBtn2.click();
      saveBtn2.click();
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      history.pushState({}, '', '/home');
      expect(document.getElementById('ala-settings-backdrop')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
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
      expect(vi.getTimerCount()).toBe(1);
      document.getElementById('ala-settings-panel')?.remove();
      vi.advanceTimersByTime(350);
      expect(vi.getTimerCount()).toBe(0);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      closePanel();
      history.replaceState({}, '', '/settings');
      vi.advanceTimersByTime(150);
      document.getElementById('ala-settings-mobile-launcher')?.remove();
      document.getElementById('ala-settings-style')?.remove();
    }
  });
});
