import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/modules/keyframe';
import { Core } from '../src/core/observer';
import { bootModuleForTest, disposeFeature } from '../src/core/registry';
import { Settings } from '../src/settings/settings';

const LINK_ID = 'ala-keyframe-link';
const LINK_SEL = `#${LINK_ID}`;

function renderFilters(withMiniSelect = true): HTMLElement {
  document.body.innerHTML = `
    <div class="filters">
      ${
        withMiniSelect
          ? `<div class="mini-select" data-v-abc123=""><svg data-v-abc123=""></svg><span class="label" data-v-abc123="">Filter</span></div>`
          : ''
      }
    </div>
  `;
  return document.querySelector('.filters') as HTMLElement;
}

describe('keyframe module (BUG-72)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    disposeFeature('keyframe');
    history.replaceState({}, '', '/');
  });

  it('mounts skinned link on staff and studio routes and stops click propagation', async () => {
    renderFilters(true);
    history.replaceState({}, '', '/staff/105749');
    Settings.set('keyframeEnabled', true);

    await bootModuleForTest('keyframe');

    const link = document.getElementById(LINK_ID) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.href).toBe('https://keyframe-staff-list.com/person/105749');
    expect(link!.classList.contains('mini-select')).toBe(true);
    expect(link!.hasAttribute('data-v-abc123')).toBe(true);

    const parentClick = vi.fn();
    document.querySelector('.filters')!.addEventListener('click', parentClick);
    link!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(parentClick).not.toHaveBeenCalled();

    renderFilters(false);
    history.pushState({}, '', '/studio/21');
    const studioLink = document.getElementById(LINK_ID) as HTMLAnchorElement | null;
    expect(studioLink).not.toBeNull();
    expect(studioLink!.href).toBe('https://keyframe-staff-list.com/studio/21');
    expect(studioLink!.classList.contains('ala-kf-plain')).toBe(true);
  });

  it('registers #ala-keyframe-link as ownUi so internal mutations do not trigger Core.onBodyMutation and unregisters on route exit', async () => {
    vi.useFakeTimers();
    const registerSpy = vi.spyOn(Core, 'registerOwnUi');
    renderFilters(false);
    history.replaceState({}, '', '/staff/42');
    Settings.set('keyframeEnabled', true);

    await bootModuleForTest('keyframe');
    expect(registerSpy).toHaveBeenCalledWith(LINK_SEL);

    // Flush initial DOM setup before observing internal mutations
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60);

    const mutSpy = vi.fn();
    const unsubMut = Core.onBodyMutation(mutSpy);
    try {
      const link = document.getElementById(LINK_ID)!;
      link.appendChild(document.createElement('span'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      expect(mutSpy).not.toHaveBeenCalled();

      // Navigating away tears down the route mount and its ownUi registration
      history.pushState({}, '', '/anime/1');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      mutSpy.mockClear();

      const stray = document.createElement('a');
      stray.id = LINK_ID;
      document.body.appendChild(stray);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      mutSpy.mockClear();

      stray.appendChild(document.createElement('span'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      expect(mutSpy).toHaveBeenCalledTimes(1);
    } finally {
      unsubMut();
    }
  });

  it('uses element-owned click listener with zero route-cleanup accumulation across simulated Vue re-mounts', async () => {
    vi.useFakeTimers();
    renderFilters(true);
    history.replaceState({}, '', '/staff/999');
    Settings.set('keyframeEnabled', true);

    const createdAnchors: HTMLAnchorElement[] = [];
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const el = origCreateElement(tagName, options);
      if (tagName.toLowerCase() === 'a') {
        createdAnchors.push(el as HTMLAnchorElement);
      }
      return el;
    }) as typeof document.createElement);

    const removeListenerSpy = vi.spyOn(EventTarget.prototype, 'removeEventListener');

    await bootModuleForTest('keyframe');
    expect(createdAnchors).toHaveLength(1);

    // Simulate 5 Vue re-renders replacing .filters and detaching the previous anchor
    for (let i = 0; i < 5; i++) {
      renderFilters(true);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);

      const mounted = document.getElementById(LINK_ID) as HTMLAnchorElement | null;
      expect(mounted).not.toBeNull();
      const parentClick = vi.fn();
      document.querySelector('.filters')!.addEventListener('click', parentClick);
      mounted!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(parentClick).not.toHaveBeenCalled();
    }

    expect(createdAnchors).toHaveLength(6);

    // Navigating away must not iterate over detached anchors to remove route-scoped listeners
    removeListenerSpy.mockClear();
    history.pushState({}, '', '/home');

    const anchorClickRemovals = removeListenerSpy.mock.calls.filter(
      ([type], idx) => type === 'click' && createdAnchors.includes(removeListenerSpy.mock.contexts[idx] as HTMLAnchorElement)
    );
    expect(anchorClickRemovals).toHaveLength(0);
  });
});
