import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promptPasswordModal, closePasswordModal } from '../src/settings/passwordModal';
import { showPanel, closePanel } from '../src/settings/panel';
import { createModal, hasActiveModal } from '../src/core/modal';
import { Core } from '../src/core/observer';

describe('Password Modal Component', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts into DOM with title, description, and submit text', () => {
    promptPasswordModal({
      title: 'Encrypt Settings',
      description: 'Enter a strong password',
      submitText: 'Encrypt'
    });

    const backdrop = document.getElementById('ala-pwd-backdrop');
    const title = document.getElementById('ala-pwd-title');
    const desc = document.querySelector('.ala-pwd-desc');
    const submitBtn = document.getElementById('ala-pwd-btn-submit');

    expect(backdrop).not.toBeNull();
    expect(title?.textContent).toBe('Encrypt Settings');
    expect(desc?.textContent).toBe('Enter a strong password');
    expect(submitBtn?.textContent?.trim()).toBe('Encrypt');
  });

  it('resolves with the entered password on valid submit', async () => {
    const modalPromise = promptPasswordModal({
      title: 'Enter Password'
    });

    const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
    const submitBtn = document.querySelector<HTMLButtonElement>('#ala-pwd-btn-submit')!;

    input.value = 'MySecret123';
    submitBtn.click();

    const result = await modalPromise;
    expect(result).toBe('MySecret123');
    expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
  });

  it('toggles password input visibility when the eye button is clicked', () => {
    promptPasswordModal({
      title: 'Toggle Test',
      confirm: true
    });

    const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
    const confirmInput = document.querySelector<HTMLInputElement>('#ala-pwd-input-confirm')!;
    const toggleBtn = document.querySelector<HTMLButtonElement>('.ala-pwd-toggle')!;

    expect(input.type).toBe('password');
    expect(confirmInput.type).toBe('password');

    toggleBtn.click();
    expect(input.type).toBe('text');
    expect(confirmInput.type).toBe('text');

    toggleBtn.click();
    expect(input.type).toBe('password');
    expect(confirmInput.type).toBe('password');
  });

  it('prevents submission and displays error when input is empty and allowEmpty is false', async () => {
    promptPasswordModal({
      title: 'Validation Test',
      allowEmpty: false
    });

    const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
    const submitBtn = document.querySelector<HTMLButtonElement>('#ala-pwd-btn-submit')!;
    const errBox = document.querySelector<HTMLElement>('#ala-pwd-err')!;

    input.value = '   ';
    submitBtn.click();

    expect(errBox.style.display).toBe('block');
    expect(errBox.textContent).toBe('Password cannot be empty.');
    expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();
  });

  it('allows empty password submission when allowEmpty is true', async () => {
    const modalPromise = promptPasswordModal({
      title: 'Optional Password',
      allowEmpty: true
    });

    const submitBtn = document.querySelector<HTMLButtonElement>('#ala-pwd-btn-submit')!;
    submitBtn.click();

    const result = await modalPromise;
    expect(result).toBe('');
    expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
  });

  it('prevents submission when password confirmation does not match', async () => {
    promptPasswordModal({
      title: 'Confirm Test',
      confirm: true
    });

    const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
    const confirmInput = document.querySelector<HTMLInputElement>('#ala-pwd-input-confirm')!;
    const submitBtn = document.querySelector<HTMLButtonElement>('#ala-pwd-btn-submit')!;
    const errBox = document.querySelector<HTMLElement>('#ala-pwd-err')!;

    input.value = 'Password123';
    confirmInput.value = 'Password321';
    submitBtn.click();

    expect(errBox.style.display).toBe('block');
    expect(errBox.textContent).toBe('Passwords do not match.');
    expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();
  });

  it('cancels and resolves null when Cancel button is clicked', async () => {
    const modalPromise = promptPasswordModal({ title: 'Cancel Test' });
    const cancelBtn = document.querySelector<HTMLButtonElement>('#ala-pwd-btn-cancel')!;

    cancelBtn.click();

    const result = await modalPromise;
    expect(result).toBeNull();
    expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
  });

  it('cancels and resolves null when Close (✕) button is clicked', async () => {
    const modalPromise = promptPasswordModal({ title: 'Close Test' });
    const closeBtn = document.querySelector<HTMLButtonElement>('.ala-pwd-btn-close')!;

    closeBtn.click();

    const result = await modalPromise;
    expect(result).toBeNull();
    expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
  });

  it('cancels and resolves null when clicking the outer backdrop', async () => {
    const modalPromise = promptPasswordModal({ title: 'Backdrop Click Test' });
    const backdrop = document.getElementById('ala-pwd-backdrop')!;

    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const result = await modalPromise;
    expect(result).toBeNull();
    expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
  });

  it('cancels and resolves null when Escape key is pressed', async () => {
    const modalPromise = promptPasswordModal({ title: 'Escape Test' });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    const result = await modalPromise;
    expect(result).toBeNull();
    expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
  });

  it('submits when Enter key is pressed', async () => {
    const modalPromise = promptPasswordModal({ title: 'Enter Key Test' });
    const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;

    input.value = 'SubmittedViaEnter';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    const result = await modalPromise;
    expect(result).toBe('SubmittedViaEnter');
    expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
  });

  it('settles prior promise with null and cleans up listeners and styles when re-opened', async () => {
    const firstPromise = promptPasswordModal({ title: 'First Modal' });
    expect(document.getElementById('ala-pwd-modal-style')).not.toBeNull();

    const secondPromise = promptPasswordModal({ title: 'Second Modal' });
    await expect(firstPromise).resolves.toBeNull();

    expect(document.querySelectorAll('#ala-pwd-backdrop')).toHaveLength(1);
    expect(document.getElementById('ala-pwd-title')?.textContent).toBe('Second Modal');

    const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
    input.value = 'SecondSecret';
    document.querySelector<HTMLButtonElement>('#ala-pwd-btn-submit')!.click();

    await expect(secondPromise).resolves.toBe('SecondSecret');
    expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
    expect(document.getElementById('ala-pwd-modal-style')).toBeNull();

    const strayEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(strayEscape);
    expect(strayEscape.defaultPrevented).toBe(false);
  });

  it('closes cleanly via closePasswordModal and cancels pending focus timer and styles', async () => {
    vi.useFakeTimers();
    try {
      const modalPromise = promptPasswordModal({ title: 'Cancel Via API' });
      const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
      const focusSpy = vi.spyOn(input, 'focus');

      closePasswordModal();
      await expect(modalPromise).resolves.toBeNull();

      vi.advanceTimersByTime(100);
      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
      expect(document.getElementById('ala-pwd-modal-style')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents Escape from closing an underlying Settings Panel', async () => {
    showPanel();
    try {
      expect(document.getElementById('ala-settings-backdrop')).not.toBeNull();

      const modalPromise = promptPasswordModal({ title: 'Nested Escape Test' });
      const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.getElementById('ala-pwd-input-main')!.dispatchEvent(escEvent);

      await expect(modalPromise).resolves.toBeNull();
      expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
      expect(document.getElementById('ala-settings-backdrop')).not.toBeNull();

      const secondPromise = promptPasswordModal({ title: 'Document Escape Test' });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

      await expect(secondPromise).resolves.toBeNull();
      expect(document.getElementById('ala-settings-backdrop')).not.toBeNull();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(document.getElementById('ala-settings-backdrop')).toBeNull();
    } finally {
      closePanel();
    }
  });

  it('does not submit when Enter is pressed on Cancel, Close, or visibility toggle buttons', async () => {
    const modalPromise = promptPasswordModal({ title: 'Button Enter Guard' });
    const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
    const cancelBtn = document.querySelector<HTMLButtonElement>('#ala-pwd-btn-cancel')!;
    const closeBtn = document.querySelector<HTMLButtonElement>('.ala-pwd-btn-close')!;
    const toggleBtn = document.querySelector<HTMLButtonElement>('.ala-pwd-toggle')!;
    const toggleSvg = toggleBtn.querySelector('svg')!;

    input.value = 'ShouldWait';

    for (const target of [cancelBtn, closeBtn, toggleBtn, toggleSvg]) {
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();
    }

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await expect(modalPromise).resolves.toBe('ShouldWait');
  });

  it('blocks Enter on external button, link, and input elements within 50ms of opening without submitting or reopening', async () => {
    vi.useFakeTimers();
    try {
      const extBtn = document.createElement('button');
      extBtn.type = 'button';
      extBtn.id = 'ext-btn';
      extBtn.textContent = 'External Export';

      const extLink = document.createElement('a');
      extLink.href = '#external';
      extLink.id = 'ext-link';
      extLink.textContent = 'External Link';

      const extInput = document.createElement('input');
      extInput.id = 'ext-input';
      extInput.type = 'text';

      document.body.append(extBtn, extLink, extInput);

      const extKeydown = vi.fn();
      const extBtnClick = vi.fn(() => {
        void promptPasswordModal({ title: 'Reopened Modal' });
      });
      const extLinkClick = vi.fn((ev: MouseEvent) => {
        ev.preventDefault();
      });

      extBtn.addEventListener('keydown', extKeydown);
      extBtn.addEventListener('click', extBtnClick);
      extLink.addEventListener('keydown', extKeydown);
      extLink.addEventListener('click', extLinkClick);
      extInput.addEventListener('keydown', extKeydown);

      extBtn.focus();
      let settled = false;
      const modalPromise = promptPasswordModal({
        title: 'Protected Modal',
        confirm: true
      }).then((val) => {
        settled = true;
        return val;
      });

      const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
      const confirmInput = document.querySelector<HTMLInputElement>('#ala-pwd-input-confirm')!;
      input.value = 'ValidSecret';
      confirmInput.value = 'ValidSecret';

      vi.advanceTimersByTime(25);
      expect(document.activeElement).toBe(extBtn);

      for (const target of [extBtn, extLink, extInput]) {
        target.focus();
        const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        if (!ev.defaultPrevented && (target === extBtn || target === extLink)) {
          target.click();
        }
        expect(ev.defaultPrevented).toBe(true);
        expect(settled).toBe(false);
        expect(document.querySelectorAll('#ala-pwd-backdrop')).toHaveLength(1);
        expect(document.getElementById('ala-pwd-title')?.textContent).toBe('Protected Modal');
        expect(document.getElementById('ala-pwd-err')?.style.display).toBe('none');
      }

      expect(extKeydown).not.toHaveBeenCalled();
      expect(extBtnClick).not.toHaveBeenCalled();
      expect(extLinkClick).not.toHaveBeenCalled();

      vi.advanceTimersByTime(25);
      expect(document.activeElement).toBe(input);
      const submitEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      input.dispatchEvent(submitEv);
      expect(submitEv.defaultPrevented).toBe(true);

      await expect(modalPromise).resolves.toBe('ValidSecret');
      expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks external role="button" and empty-state external Enter while preserving SVG toggle children and document/body/confirm Enter submission', async () => {
    const extRoleBtn = document.createElement('div');
    extRoleBtn.setAttribute('role', 'button');
    extRoleBtn.tabIndex = 0;
    const extInput = document.createElement('input');
    document.body.append(extRoleBtn, extInput);

    const extKeydown = vi.fn();
    const extClick = vi.fn();
    extRoleBtn.addEventListener('keydown', extKeydown);
    extRoleBtn.addEventListener('click', extClick);
    extInput.addEventListener('keydown', extKeydown);

    const firstPromise = promptPasswordModal({ title: 'Scope Edge Cases', confirm: true });
    const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
    const confirmInput = document.querySelector<HTMLInputElement>('#ala-pwd-input-confirm')!;
    const togglePath = document.querySelector('.ala-pwd-toggle svg path')!;

    for (const target of [extRoleBtn, extInput]) {
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      if (!ev.defaultPrevented && target === extRoleBtn) target.click();
      expect(ev.defaultPrevented).toBe(true);
      expect(document.getElementById('ala-pwd-err')?.style.display).toBe('none');
      expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();
    }
    expect(extKeydown).not.toHaveBeenCalled();
    expect(extClick).not.toHaveBeenCalled();

    const svgChildEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    togglePath.dispatchEvent(svgChildEv);
    expect(svgChildEv.defaultPrevented).toBe(false);
    expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();

    input.value = 'ConfirmSubmit';
    confirmInput.value = 'ConfirmSubmit';
    const confirmEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    confirmInput.dispatchEvent(confirmEv);
    expect(confirmEv.defaultPrevented).toBe(true);
    await expect(firstPromise).resolves.toBe('ConfirmSubmit');

    const bodyPromise = promptPasswordModal({ title: 'Body Enter Submit' });
    document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!.value = 'BodySecret';
    const bodyEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.body.dispatchEvent(bodyEv);
    expect(bodyEv.defaultPrevented).toBe(true);
    await expect(bodyPromise).resolves.toBe('BodySecret');

    const docPromise = promptPasswordModal({ title: 'Document Enter Submit' });
    document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!.value = 'DocSecret';
    const docEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.dispatchEvent(docEv);
    expect(docEv.defaultPrevented).toBe(true);
    await expect(docPromise).resolves.toBe('DocSecret');
  });

  it('rejects mismatched empty password and non-empty confirmation when allowEmpty and confirm are both true', async () => {
    const modalPromise = promptPasswordModal({
      title: 'Optional Encrypted Export',
      allowEmpty: true,
      confirm: true
    });

    const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
    const confirmInput = document.querySelector<HTMLInputElement>('#ala-pwd-input-confirm')!;
    const submitBtn = document.querySelector<HTMLButtonElement>('#ala-pwd-btn-submit')!;
    const errBox = document.querySelector<HTMLElement>('#ala-pwd-err')!;

    input.value = '';
    confirmInput.value = 'abc';
    submitBtn.click();

    expect(errBox.style.display).toBe('block');
    expect(errBox.textContent).toBe('Passwords do not match.');
    expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();

    confirmInput.value = '';
    submitBtn.click();
    await expect(modalPromise).resolves.toBe('');
  });

  it('returns null without mounting styles when document.body is null', async () => {
    const origBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      await expect(promptPasswordModal({ title: 'No Body' })).resolves.toBeNull();
      expect(document.getElementById('ala-pwd-modal-style')).toBeNull();
    } finally {
      delete (document as any).body;
      if (!document.body && origBody) document.documentElement.appendChild(origBody);
    }
  });

  it('rejects whitespace-only passwords even when allowEmpty is true and refocuses input (BUG-39)', async () => {
    const modalPromise = promptPasswordModal({
      title: 'Optional Password',
      allowEmpty: true,
      confirm: true
    });

    const input = document.querySelector<HTMLInputElement>('#ala-pwd-input-main')!;
    const confirmInput = document.querySelector<HTMLInputElement>('#ala-pwd-input-confirm')!;
    const submitBtn = document.querySelector<HTMLButtonElement>('#ala-pwd-btn-submit')!;
    const errBox = document.querySelector<HTMLElement>('#ala-pwd-err')!;
    const focusSpy = vi.spyOn(input, 'focus');

    input.value = '   ';
    confirmInput.value = '   ';
    submitBtn.click();

    expect(errBox.style.display).toBe('block');
    expect(errBox.textContent).toBe('Password cannot contain only whitespace.');
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();

    input.value = '';
    confirmInput.value = '';
    submitBtn.click();
    await expect(modalPromise).resolves.toBe('');
  });

  it('registers #ala-pwd-backdrop as ownUi so internal mutations do not fire Core.onBodyMutation, disposes on cleanup, and bundles scoped CSS (BUG-40)', async () => {
    vi.useFakeTimers();
    const registerSpy = vi.spyOn(Core, 'registerOwnUi');
    const mutSpy = vi.fn();
    let unsubMut: (() => void) | null = null;
    try {
      const modalPromise = promptPasswordModal({ title: 'OwnUi & CSS Test' });
      expect(registerSpy).toHaveBeenCalledWith('#ala-pwd-backdrop');

      const styleEl = document.getElementById('ala-pwd-modal-style') as HTMLStyleElement | null;
      expect(styleEl).not.toBeNull();
      const css = styleEl?.textContent || '';
      for (const selector of [
        '#ala-pwd-backdrop .ala-sheet',
        '#ala-pwd-backdrop .ala-sheet-head',
        '#ala-pwd-backdrop .ala-sheet-body',
        '#ala-pwd-backdrop .ala-sheet-foot',
        '#ala-pwd-backdrop .ala-btn',
        '#ala-pwd-backdrop .ala-btn--primary',
        '#ala-pwd-backdrop .ala-icon-btn'
      ]) {
        expect(css).toContain(selector);
      }

      // Let the initial document.body.appendChild settle before observing internal mutations
      await Promise.resolve();
      unsubMut = Core.onBodyMutation(mutSpy);

      const toggleBtn = document.querySelector<HTMLButtonElement>('.ala-pwd-toggle')!;
      const submitBtn = document.querySelector<HTMLButtonElement>('#ala-pwd-btn-submit')!;
      toggleBtn.click();
      submitBtn.click();

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      expect(mutSpy).not.toHaveBeenCalled();

      closePasswordModal();
      await expect(modalPromise).resolves.toBeNull();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);

      // After cleanup(), #ala-pwd-backdrop is no longer registered as ownUi
      mutSpy.mockClear();
      const stray = document.createElement('div');
      stray.id = 'ala-pwd-backdrop';
      document.body.appendChild(stray);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      mutSpy.mockClear();

      stray.appendChild(document.createElement('span'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      expect(mutSpy).toHaveBeenCalledTimes(1);
      stray.remove();
    } finally {
      registerSpy.mockRestore();
      unsubMut?.();
      closePasswordModal();
      vi.useRealTimers();
    }
  });

  it('coordinates LIFO Escape handling and hasActiveModal() across createModal and promptPasswordModal (BUG-21)', async () => {
    expect(hasActiveModal()).toBe(false);

    const under = createModal({ id: 'under-pwd-modal', title: 'Underlying Modal' });
    try {
      expect(hasActiveModal()).toBe(true);

      const pwdPromise = promptPasswordModal({ title: 'Top Password Modal' });
      expect(hasActiveModal()).toBe(true);
      expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();
      expect(document.getElementById('ala-under-pwd-modal')).not.toBeNull();

      const lateCaptureSpy = vi.fn();
      document.addEventListener('keydown', lateCaptureSpy, true);
      try {
        const esc1 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.dispatchEvent(esc1);
        expect(esc1.defaultPrevented).toBe(true);
        expect(lateCaptureSpy).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener('keydown', lateCaptureSpy, true);
      }

      await expect(pwdPromise).resolves.toBeNull();
      expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
      expect(document.getElementById('ala-under-pwd-modal')).not.toBeNull();
      expect(under.signal.aborted).toBe(false);
      expect(hasActiveModal()).toBe(true);

      const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(esc2);
      expect(esc2.defaultPrevented).toBe(true);
      expect(document.getElementById('ala-under-pwd-modal')).toBeNull();
      expect(under.signal.aborted).toBe(true);
      expect(hasActiveModal()).toBe(false);
    } finally {
      under.close();
      closePasswordModal();
    }

    // Reverse stacking order: createModal opened on top of promptPasswordModal
    const pwdUnder = promptPasswordModal({ title: 'Lower Password Modal' });
    const over = createModal({ id: 'over-pwd-modal', title: 'Top Core Modal' });
    try {
      expect(hasActiveModal()).toBe(true);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(over.signal.aborted).toBe(true);
      expect(document.getElementById('ala-pwd-backdrop')).not.toBeNull();
      expect(hasActiveModal()).toBe(true);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await expect(pwdUnder).resolves.toBeNull();
      expect(document.getElementById('ala-pwd-backdrop')).toBeNull();
      expect(hasActiveModal()).toBe(false);
    } finally {
      over.close();
      closePasswordModal();
    }
  });
});