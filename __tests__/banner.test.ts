import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/modules/banner';
import { safeDecodeURIComponent, sanitizeBannerSlug } from '../src/modules/banner';
import { bootModuleForTest, createModuleHost, disposeFeature } from '../src/core/registry';
import { Settings } from '../src/settings/settings';

const flushMicrotasks = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe('banner helpers', () => {
  it('safely decodes URL-encoded usernames and falls back on malformed sequences', () => {
    expect(safeDecodeURIComponent('Alice%20Smith')).toBe('Alice Smith');
    expect(safeDecodeURIComponent('%E3%83%A6%E3%83%BC%E3%82%B6')).toBe('ユーザ');
    expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('sanitizes unsafe filename characters in banner slugs', () => {
    expect(sanitizeBannerSlug('foo/bar\\baz:1?*"<>|')).toBe('foo_bar_baz_1______');
    expect(sanitizeBannerSlug('')).toBe('anilist');
    expect(sanitizeBannerSlug('..')).toBe('anilist');
  });
});

describe('banner module (BUG-65)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    disposeFeature('banner');
    history.replaceState({}, '', '/');
  });

  it('tears down "Saved" state and binds the new slug on /anime/1 -> /anime/2 transitions (even when Vue reuses .banner)', async () => {
    vi.useFakeTimers();

    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.style.backgroundImage = 'url("https://img.example/1.jpg")';
    document.body.appendChild(banner);

    const downloads: Array<{ url: string; name: string }> = [];
    vi.mocked(globalThis.GM_download).mockImplementation((opts: any) => {
      downloads.push({ url: opts.url, name: opts.name });
      opts.onload?.();
      return { abort: vi.fn() };
    });

    history.replaceState({}, '', '/anime/1');
    Settings.set('bannerEnabled', true);
    await bootModuleForTest('banner');

    const btn1 = document.getElementById('ala-banner-dl') as HTMLButtonElement | null;
    expect(btn1).not.toBeNull();
    expect(btn1?.parentElement).toBe(banner);

    btn1!.click();
    await flushMicrotasks();

    expect(downloads).toEqual([{ url: 'https://img.example/1.jpg', name: 'anilist-banner-1.jpg' }]);
    expect(btn1!.classList.contains('is-done')).toBe(true);
    expect(btn1!.querySelector('.ala-banner-lbl')?.textContent).toBe('Saved');

    // Navigate to /anime/2 while Vue reuses the same .banner element and updates its style asynchronously
    banner.style.backgroundImage = '';
    history.pushState({}, '', '/anime/2');
    await flushMicrotasks();

    // Old "Saved" button must be gone immediately
    expect(btn1!.isConnected).toBe(false);
    expect(document.getElementById('ala-banner-dl')).toBeNull();

    // Vue restores the reused .banner's backgroundImage for anime 2
    banner.style.backgroundImage = 'url("https://img.example/2.webp")';
    await flushMicrotasks();
    vi.advanceTimersByTime(60);

    const btn2 = document.getElementById('ala-banner-dl') as HTMLButtonElement | null;
    expect(btn2).not.toBeNull();
    expect(btn2).not.toBe(btn1);
    expect(btn2!.classList.contains('is-done')).toBe(false);
    expect(btn2!.querySelector('.ala-banner-lbl')?.textContent).toBe('Download banner');

    btn2!.click();
    await flushMicrotasks();

    expect(downloads).toEqual([
      { url: 'https://img.example/1.jpg', name: 'anilist-banner-1.jpg' },
      { url: 'https://img.example/2.webp', name: 'anilist-banner-2.webp' }
    ]);
    expect(btn2!.classList.contains('is-done')).toBe(true);
    expect(btn2!.querySelector('.ala-banner-lbl')?.textContent).toBe('Saved');
  });

  it('resets "Saved" state after 1600ms and cancels pending reset on route exit', async () => {
    vi.useFakeTimers();

    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.style.backgroundImage = 'url("https://img.example/10.png")';
    document.body.appendChild(banner);

    vi.mocked(globalThis.GM_download).mockImplementation((opts: any) => {
      opts.onload?.();
      return { abort: vi.fn() };
    });

    history.replaceState({}, '', '/manga/10');
    Settings.set('bannerEnabled', true);
    await bootModuleForTest('banner');

    const btn = document.getElementById('ala-banner-dl') as HTMLButtonElement;
    btn.click();
    await flushMicrotasks();

    expect(btn.classList.contains('is-done')).toBe(true);
    expect(btn.querySelector('.ala-banner-lbl')?.textContent).toBe('Saved');

    vi.advanceTimersByTime(1600);
    expect(btn.classList.contains('is-done')).toBe(false);
    expect(btn.querySelector('.ala-banner-lbl')?.textContent).toBe('Download banner');

    // Trigger "Saved" again, then navigate to a non-banner route before 1600ms
    btn.click();
    await flushMicrotasks();
    expect(btn.classList.contains('is-done')).toBe(true);

    history.pushState({}, '', '/home');
    expect(btn.isConnected).toBe(false);
    expect(document.getElementById('ala-banner-dl')).toBeNull();

    // Advancing past 1600ms must not re-mutate the detached button
    vi.advanceTimersByTime(2000);
    expect(btn.classList.contains('is-done')).toBe(true);
  });

  it('decodes URL-encoded usernames safely when bannerProfiles is enabled', async () => {
    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.style.backgroundImage = 'url("https://img.example/u.jpg")';
    document.body.appendChild(banner);

    const downloads: Array<{ url: string; name: string }> = [];
    vi.mocked(globalThis.GM_download).mockImplementation((opts: any) => {
      downloads.push({ url: opts.url, name: opts.name });
      opts.onload?.();
      return { abort: vi.fn() };
    });

    history.replaceState({}, '', '/user/Alice%20Smith');
    Settings.set('bannerEnabled', true);
    Settings.set('bannerProfiles', false);
    await bootModuleForTest('banner');

    expect(document.getElementById('ala-banner-dl')).toBeNull();

    Settings.set('bannerProfiles', true);
    createModuleHost().reload(['banner']);

    const btn1 = document.getElementById('ala-banner-dl') as HTMLButtonElement | null;
    expect(btn1).not.toBeNull();
    btn1!.click();
    await flushMicrotasks();

    history.pushState({}, '', '/user/%E0%A4%A');
    const btn2 = document.getElementById('ala-banner-dl') as HTMLButtonElement | null;
    expect(btn2).not.toBeNull();
    btn2!.click();
    await flushMicrotasks();

    expect(downloads).toEqual([
      { url: 'https://img.example/u.jpg', name: 'anilist-banner-Alice Smith.jpg' },
      { url: 'https://img.example/u.jpg', name: 'anilist-banner-%E0%A4%A.jpg' }
    ]);
  });

  it('cancels pending timers and aborts in-flight downloads silently on disposal without error toast', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.style.backgroundImage = 'url("https://img.example/99.jpg")';
    document.body.appendChild(banner);

    const abortSpy = vi.fn();
    vi.mocked(globalThis.GM_download).mockImplementation(() => ({ abort: abortSpy }));

    history.replaceState({}, '', '/anime/99');
    Settings.set('bannerEnabled', true);
    await bootModuleForTest('banner');

    const btn = document.getElementById('ala-banner-dl') as HTMLButtonElement;
    btn.click();

    // Disable and reload module while download is in-flight and 300ms fallback timer is pending
    Settings.set('bannerEnabled', false);
    createModuleHost().reload(['banner']);
    await flushMicrotasks();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(document.getElementById('ala-banner-dl')).toBeNull();

    // Advancing timers after disposal must do nothing
    vi.advanceTimersByTime(2000);
    expect(document.getElementById('ala-banner-dl')).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(document.getElementById('ala-toast')).toBeNull();
  });

  it('logs a warning and shows an error toast for non-abort download errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('Popup blocked');
    });
    vi.mocked(globalThis.GM_download).mockImplementation(() => {
      throw new Error('GM_download failed');
    });

    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.style.backgroundImage = 'url("https://img.example/err.jpg")';
    document.body.appendChild(banner);

    history.replaceState({}, '', '/anime/77');
    Settings.set('bannerEnabled', true);
    await bootModuleForTest('banner');

    const btn = document.getElementById('ala-banner-dl') as HTMLButtonElement;
    btn.click();
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toBe('[Anime/Manga Banner Downloader]');
    const toast = document.getElementById('ala-toast');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toBe('Failed to download banner image.');
  });

  it('BUG-40: aborts in-flight banner download on route exit and prevents openTabOnError on later pages', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.style.backgroundImage = 'url("https://img.example/route-exit.jpg")';
    document.body.appendChild(banner);

    const abortSpy = vi.fn();
    let capturedOpts: any = null;
    vi.mocked(globalThis.GM_download).mockImplementation((opts: any) => {
      capturedOpts = opts;
      return { abort: abortSpy };
    });

    history.replaceState({}, '', '/anime/42');
    Settings.set('bannerEnabled', true);
    await bootModuleForTest('banner');

    const btn = document.getElementById('ala-banner-dl') as HTMLButtonElement;
    btn.click();
    expect(capturedOpts).not.toBeNull();

    // Navigate away while the download is still in-flight
    history.pushState({}, '', '/home');
    await flushMicrotasks();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(document.getElementById('ala-banner-dl')).toBeNull();

    // Even if the underlying download reports a late error/timeout after route exit,
    // openTabOnError must stay suppressed and no error toast/warning may appear on the new page.
    capturedOpts.onerror?.({ error: 'failed' });
    capturedOpts.ontimeout?.();
    await flushMicrotasks();

    expect(anchorClickSpy).not.toHaveBeenCalled();
    expect(windowOpenSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(document.getElementById('ala-toast')).toBeNull();
  });

  it('IMP-04: reacts to banner attribute mutations via rc.observe and auto-disconnects on route exit', async () => {
    vi.useFakeTimers();

    let attrObserverInstance: MutationObserver | undefined;
    const origObserve = MutationObserver.prototype.observe;
    const observeSpy = vi.spyOn(MutationObserver.prototype, 'observe').mockImplementation(function (
      this: MutationObserver,
      target: Node,
      options?: MutationObserverInit
    ) {
      if (options?.attributeFilter?.includes('style')) {
        attrObserverInstance = this;
      }
      return origObserve.call(this, target, options);
    });
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect');

    const banner = document.createElement('div');
    banner.className = 'banner';
    document.body.appendChild(banner);

    history.replaceState({}, '', '/anime/55');
    Settings.set('bannerEnabled', true);
    await bootModuleForTest('banner');

    // No backgroundImage yet -> no button mounted, but rc.observe is observing document.body attributes
    expect(document.getElementById('ala-banner-dl')).toBeNull();
    expect(attrObserverInstance).toBeDefined();
    expect(observeSpy).toHaveBeenCalledWith(document.body, {
      attributes: true,
      attributeFilter: ['style', 'class'],
      subtree: true
    });

    // Mutate style attribute on .banner -> rc.observe triggers scheduleSync and mounts button
    banner.style.backgroundImage = 'url("https://img.example/55.jpg")';
    await flushMicrotasks();
    vi.advanceTimersByTime(60);

    const btn = document.getElementById('ala-banner-dl') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.parentElement).toBe(banner);

    // Exiting the route auto-disconnects the rc.observe MutationObserver
    disconnectSpy.mockClear();
    history.pushState({}, '', '/home');
    await flushMicrotasks();

    expect(disconnectSpy.mock.instances).toContain(attrObserverInstance);
    expect(document.getElementById('ala-banner-dl')).toBeNull();

    // Later attribute mutations on the banner no longer mount a button
    banner.style.backgroundImage = 'url("https://img.example/55-later.jpg")';
    await flushMicrotasks();
    vi.advanceTimersByTime(100);
    expect(document.getElementById('ala-banner-dl')).toBeNull();
  });
});
