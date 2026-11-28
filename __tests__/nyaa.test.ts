import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNyaaUrl } from '../src/modules/nyaa';
import { anilistApiClient } from '../src/api/anilist';
import { MANUAL_OVERRIDES_ENABLED_KEY, setOverride } from '../src/api/malOverrides';
import { ServiceRegistry } from '../src/core/bus';
import { bootModuleForTest, disposeFeature } from '../src/core/registry';
import { Settings } from '../src/settings/settings';
import { SETTING_PREFIX } from '../src/types';
import * as helpers from '../src/utils/helpers';

const flushMicrotasks = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

function makeMediaContainer(): HTMLElement {
  document.body.innerHTML = '<div class="page-content"><div class="header"><div class="content"></div></div></div>';
  return document.querySelector<HTMLElement>('.page-content .header .content')!;
}

describe('nyaa module (BUG-76, BUG-77)', () => {
  let serviceCleanup: (() => void) | null = null;

  afterEach(() => {
    serviceCleanup?.();
    serviceCleanup = null;
    disposeFeature('nyaa');
    vi.useRealTimers();
    vi.restoreAllMocks();
    history.replaceState({}, '', '/');
  });

  describe('BUG-77: buildNyaaUrl Unicode tokenization and encoding', () => {
    it('preserves Japanese and mixed Unicode titles while normalizing punctuation', () => {
      const jp = buildNyaaUrl('進撃の巨人', ['SubsPlease', 'ToonsHub']);
      const jpUrl = new URL(jp);
      expect(jpUrl.searchParams.get('q')).toBe('進撃の巨人');
      expect(jp).toContain(`q=${encodeURIComponent('進撃の巨人')}`);
      expect(jpUrl.hash).toBe('#:~:text=SubsPlease&text=ToonsHub');

      const mixed = buildNyaaUrl('呪術廻戦 2nd Season: 渋谷事変!', ['SubsPlease']);
      const mixedUrl = new URL(mixed);
      expect(mixedUrl.searchParams.get('q')).toBe('呪術廻戦 2nd Season 渋谷事変');
      expect(mixed).toContain(
        `q=${encodeURIComponent('呪術廻戦')}+2nd+Season+${encodeURIComponent('渋谷事変')}`
      );

      const symbols = buildNyaaUrl('  ぼっち・ざ・ろっく！ / SPY×FAMILY  ');
      expect(new URL(symbols).searchParams.get('q')).toBe('ぼっち ざ ろっく SPY FAMILY');

      const empty = buildNyaaUrl('--- !!! ---');
      expect(new URL(empty).searchParams.get('q')).toBe('');
    });
  });

  describe('BUG-76: async <h1> + manualOverrides:quickEdit mounting & cleanup', () => {
    it('mounts both link and edit button when <h1> renders asynchronously after navigation', async () => {
      vi.useFakeTimers();
      const content = makeMediaContainer();
      const quickEditSpy = vi.fn();
      serviceCleanup = ServiceRegistry.provide('manualOverrides:quickEdit', quickEditSpy);

      vi.spyOn(anilistApiClient.media, 'get').mockResolvedValue({ idMal: 16498 } as any);
      history.replaceState({}, '', '/anime/16498');
      Settings.set('nyaaEnabled', true);

      await bootModuleForTest('nyaa');

      expect(document.getElementById('ala-nyaa-find-on-nyaa')).toBeNull();
      expect(document.getElementById('ala-nyaa-edit-mal-id')).toBeNull();

      const h1 = document.createElement('h1');
      h1.textContent = 'Attack on Titan';
      content.appendChild(h1);

      await flushMicrotasks();
      vi.advanceTimersByTime(60);

      const linkEl = document.getElementById('ala-nyaa-find-on-nyaa');
      const editEl = document.getElementById('ala-nyaa-edit-mal-id');
      expect(linkEl).not.toBeNull();
      expect(editEl).not.toBeNull();
      expect(linkEl?.parentElement).toBe(h1);
      expect(editEl?.parentElement).toBe(h1);

      editEl!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(quickEditSpy).toHaveBeenCalledWith(16498, 'ANIME');
    });

    it('handles late service availability, service re-fire, withdrawal, and Vue <h1> re-render without leaks', async () => {
      vi.useFakeTimers();
      const content = makeMediaContainer();
      const h1 = document.createElement('h1');
      h1.textContent = 'Frieren';
      content.appendChild(h1);

      vi.spyOn(anilistApiClient.media, 'get').mockResolvedValue({ idMal: 52991 } as any);
      history.replaceState({}, '', '/anime/154587');
      Settings.set('nyaaEnabled', true);

      await bootModuleForTest('nyaa');
      expect(document.getElementById('ala-nyaa-find-on-nyaa')).not.toBeNull();
      expect(document.getElementById('ala-nyaa-edit-mal-id')).toBeNull();

      const firstQuickEdit = vi.fn();
      const cleanupFirst = ServiceRegistry.provide('manualOverrides:quickEdit', firstQuickEdit);
      serviceCleanup = cleanupFirst;

      const edit1 = document.getElementById('ala-nyaa-edit-mal-id');
      expect(edit1).not.toBeNull();
      edit1!.click();
      expect(firstQuickEdit).toHaveBeenCalledTimes(1);

      // Re-fire with new service implementation replaces previous edit mount cleanly
      const secondQuickEdit = vi.fn();
      serviceCleanup = ServiceRegistry.provide('manualOverrides:quickEdit', secondQuickEdit);
      const edit2 = document.getElementById('ala-nyaa-edit-mal-id');
      expect(edit2).not.toBeNull();
      expect(edit2).not.toBe(edit1);
      edit2!.click();
      expect(firstQuickEdit).toHaveBeenCalledTimes(1);
      expect(secondQuickEdit).toHaveBeenCalledWith(154587, 'ANIME');

      // Simulate Vue re-rendering <h1> (detaching old anchor & edit button)
      const oldLink = document.getElementById('ala-nyaa-find-on-nyaa')!;
      h1.remove();
      const h1Next = document.createElement('h1');
      h1Next.textContent = 'Sousou no Frieren';
      content.appendChild(h1Next);
      await flushMicrotasks();
      vi.advanceTimersByTime(60);

      const newLink = document.getElementById('ala-nyaa-find-on-nyaa')!;
      const newEdit = document.getElementById('ala-nyaa-edit-mal-id')!;
      expect(newLink).not.toBe(oldLink);
      expect(newLink.parentElement).toBe(h1Next);
      expect(newEdit.parentElement).toBe(h1Next);

      // Withdrawal unmounts edit button
      serviceCleanup();
      cleanupFirst();
      serviceCleanup = null;
      expect(document.getElementById('ala-nyaa-edit-mal-id')).toBeNull();
    });
  });

  describe('BUG-77: click navigation security and abort handling', () => {
    it('routes Ctrl/Cmd+click and ignored media synchronously through openTab without about:blank', async () => {
      const content = makeMediaContainer();
      content.innerHTML = '<h1>進撃の巨人</h1>';
      vi.spyOn(anilistApiClient.media, 'get').mockResolvedValue({ idMal: 16498 } as any);
      const openTabSpy = vi.spyOn(helpers, 'openTab').mockImplementation(() => {});
      const winOpenSpy = vi.spyOn(window, 'open');

      history.replaceState({}, '', '/anime/16498');
      Settings.set('nyaaEnabled', true);
      await bootModuleForTest('nyaa');

      const link = document.getElementById('ala-nyaa-find-on-nyaa') as HTMLAnchorElement;
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));

      expect(winOpenSpy).not.toHaveBeenCalled();
      expect(openTabSpy).toHaveBeenCalledTimes(1);
      expect(new URL(openTabSpy.mock.calls[0][0]).searchParams.get('q')).toBe('進撃の巨人');

      // AniList-only ignored entry also skips window.open('about:blank')
      helpers.store.set(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY, true);
      setOverride(16498, { malId: 0, type: 'ANIME', title: '進撃の巨人' });
      vi.mocked(anilistApiClient.media.get).mockClear();

      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(winOpenSpy).not.toHaveBeenCalled();
      expect(anilistApiClient.media.get).not.toHaveBeenCalled();
      expect(openTabSpy).toHaveBeenCalledTimes(2);
    });

    it('sets w.opener = null before await and redirects on active route', async () => {
      const content = makeMediaContainer();
      content.innerHTML = '<h1>Attack on Titan</h1>';

      let resolveMedia!: (val: any) => void;
      const mediaSpy = vi.spyOn(anilistApiClient.media, 'get');
      // First call is route prefetch; second call is click lookup
      mediaSpy
        .mockResolvedValueOnce({ idMal: 16498 } as any)
        .mockImplementationOnce(() => new Promise((res) => { resolveMedia = res; }));

      const openerWrites: unknown[] = [];
      let hrefVal = 'about:blank';
      const popup = {
        closed: false,
        close: vi.fn(),
        location: {
          get href() {
            return hrefVal;
          },
          set href(v: string) {
            hrefVal = v;
          }
        }
      } as any;
      Object.defineProperty(popup, 'opener', {
        configurable: true,
        get: () => null,
        set: (v) => openerWrites.push(v)
      });
      vi.spyOn(window, 'open').mockReturnValue(popup);

      history.replaceState({}, '', '/anime/16498');
      Settings.set('nyaaEnabled', true);
      await bootModuleForTest('nyaa');

      const link = document.getElementById('ala-nyaa-find-on-nyaa') as HTMLAnchorElement;
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
      expect(openerWrites).toEqual([null]);
      expect(hrefVal).toBe('about:blank');

      resolveMedia({ idMal: 16498 });
      await flushMicrotasks();

      expect(hrefVal).toBe('https://myanimelist.net/anime/16498');
      expect(popup.close).not.toHaveBeenCalled();
    });

    it('aborts redirect and closes popup when route aborts mid-lookup, and skips redirect when popup closes', async () => {
      const content = makeMediaContainer();
      content.innerHTML = '<h1>Attack on Titan</h1>';

      let resolveAbortMedia!: (val: any) => void;
      let resolveClosedMedia!: (val: any) => void;
      const mediaSpy = vi.spyOn(anilistApiClient.media, 'get');
      mediaSpy
        .mockResolvedValueOnce({ idMal: 16498 } as any)
        .mockImplementationOnce(() => new Promise((res) => { resolveAbortMedia = res; }))
        .mockResolvedValueOnce({ idMal: 16499 } as any)
        .mockImplementationOnce(() => new Promise((res) => { resolveClosedMedia = res; }));

      history.replaceState({}, '', '/anime/16498');
      Settings.set('nyaaEnabled', true);
      await bootModuleForTest('nyaa');

      // Case 1: route navigates away mid-lookup (rc.signal.aborted becomes true)
      const popup1 = {
        closed: false,
        opener: window,
        close: vi.fn(),
        location: { href: 'about:blank' }
      } as any;
      vi.spyOn(window, 'open').mockReturnValue(popup1);

      const link1 = document.getElementById('ala-nyaa-find-on-nyaa') as HTMLAnchorElement;
      link1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(popup1.opener).toBeNull();

      history.pushState({}, '', '/home');
      await flushMicrotasks();

      resolveAbortMedia({ idMal: 16498 });
      await flushMicrotasks();

      expect(popup1.location.href).toBe('about:blank');
      expect(popup1.close).toHaveBeenCalledTimes(1);

      // Case 2: user closes popup mid-lookup (w.closed === true)
      const popup2 = {
        closed: false,
        opener: window,
        close: vi.fn(),
        location: { href: 'about:blank' }
      } as any;
      vi.mocked(window.open).mockReturnValue(popup2);
      const openTabSpy = vi.spyOn(helpers, 'openTab').mockImplementation(() => {});

      history.pushState({}, '', '/anime/16499');
      await flushMicrotasks();

      const link2 = document.getElementById('ala-nyaa-find-on-nyaa') as HTMLAnchorElement;
      link2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(popup2.opener).toBeNull();

      popup2.closed = true;
      resolveClosedMedia({ idMal: 16499 });
      await flushMicrotasks();

      expect(popup2.location.href).toBe('about:blank');
      expect(openTabSpy).not.toHaveBeenCalled();
    });

    it('BUG-47: aborts prefetch/click media.get and closes pending popup immediately on route exit', async () => {
      const content = makeMediaContainer();
      content.innerHTML = '<h1>Test Anime</h1>';

      const signals: AbortSignal[] = [];
      const resolvers: Array<(val: any) => void> = [];
      const mediaSpy = vi.spyOn(anilistApiClient.media, 'get').mockImplementation((_id, _type, opts) => {
        if (opts?.signal) signals.push(opts.signal);
        return new Promise((res) => {
          resolvers.push(res);
        });
      });

      const popup = {
        closed: false,
        opener: window,
        close: vi.fn(),
        location: { href: 'about:blank' }
      } as any;
      vi.spyOn(window, 'open').mockReturnValue(popup);

      history.replaceState({}, '', '/anime/777');
      Settings.set('nyaaEnabled', true);
      await bootModuleForTest('nyaa');

      expect(mediaSpy).toHaveBeenCalledTimes(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[0].aborted).toBe(false);

      const link = document.getElementById('ala-nyaa-find-on-nyaa') as HTMLAnchorElement;
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(mediaSpy).toHaveBeenCalledTimes(2);
      expect(signals[1]).toBeInstanceOf(AbortSignal);
      expect(signals[1].aborted).toBe(false);

      // Exit route before either media.get call resolves
      history.pushState({}, '', '/home');

      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(true);
      expect(popup.close).toHaveBeenCalledTimes(1);
      expect(popup.location.href).toBe('about:blank');

      // Resolving the aborted calls afterward does not redirect or double-close
      resolvers.forEach((resolve) => resolve({ idMal: 9999 }));
      await flushMicrotasks();

      expect(popup.close).toHaveBeenCalledTimes(1);
      expect(popup.location.href).toBe('about:blank');
    });

    it('BUG-47: clears popup tracking before redirecting so subsequent navigation leaves MAL tab open', async () => {
      const content = makeMediaContainer();
      content.innerHTML = '<h1>Test Anime</h1>';

      vi.spyOn(anilistApiClient.media, 'get').mockResolvedValue({ idMal: 8888 } as any);

      const popup = {
        closed: false,
        opener: window,
        close: vi.fn(),
        location: { href: 'about:blank' }
      } as any;
      vi.spyOn(window, 'open').mockReturnValue(popup);

      history.replaceState({}, '', '/anime/778');
      Settings.set('nyaaEnabled', true);
      await bootModuleForTest('nyaa');

      const link = document.getElementById('ala-nyaa-find-on-nyaa') as HTMLAnchorElement;
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await flushMicrotasks();

      expect(popup.location.href).toBe('https://myanimelist.net/anime/8888');

      history.pushState({}, '', '/home');
      expect(popup.close).not.toHaveBeenCalled();
    });
  });
});
