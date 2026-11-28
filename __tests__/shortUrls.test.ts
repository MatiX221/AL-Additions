import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/modules/shortUrls';
import { Core } from '../src/core/observer';
import { bootModuleForTest, disposeFeature } from '../src/core/registry';
import { Settings } from '../src/settings/settings';

describe('shortUrls module (BUG-78)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    disposeFeature('removeTitle');
    history.replaceState({}, '', '/');
  });

  it('shortens slugged media links on ready and DOM mutations while skipping setAttribute on unchanged sub-pages', async () => {
    vi.useFakeTimers();

    document.body.innerHTML = `
      <div>
        <a id="slugged" href="/anime/123/cowboy-bebop">Anime</a>
        <a id="slugged-query" href="/manga/45/berserk?tab=stats#top">Manga</a>
        <a id="slugged-abs" href="https://anilist.co/staff/7/shinichiro-watanabe/">Staff</a>
        <a id="short" href="/anime/123/">Already Short</a>
        <a id="subpage" href="/anime/123/cowboy-bebop/characters">Characters</a>
        <a id="subpage-abs" href="https://anilist.co/anime/123/cowboy-bebop/reviews">Reviews</a>
      </div>
    `;

    const subpage = document.getElementById('subpage') as HTMLAnchorElement;
    const subpageAbs = document.getElementById('subpage-abs') as HTMLAnchorElement;
    const short = document.getElementById('short') as HTMLAnchorElement;
    const slugged = document.getElementById('slugged') as HTMLAnchorElement;

    const subpageSetSpy = vi.spyOn(subpage, 'setAttribute');
    const subpageAbsSetSpy = vi.spyOn(subpageAbs, 'setAttribute');
    const shortSetSpy = vi.spyOn(short, 'setAttribute');
    const sluggedSetSpy = vi.spyOn(slugged, 'setAttribute');

    history.replaceState({}, '', '/home');
    Settings.set('linkShortenerEnabled', true);
    await bootModuleForTest('removeTitle');

    expect(slugged.getAttribute('href')).toBe('/anime/123/');
    expect(document.getElementById('slugged-query')?.getAttribute('href')).toBe('/manga/45/?tab=stats#top');
    expect(document.getElementById('slugged-abs')?.getAttribute('href')).toBe('https://anilist.co/staff/7/');
    expect(sluggedSetSpy).toHaveBeenCalledTimes(1);

    // Unchanged sub-pages and already-shortened links must not incur setAttribute writes
    expect(subpage.getAttribute('href')).toBe('/anime/123/cowboy-bebop/characters');
    expect(subpageAbs.getAttribute('href')).toBe('https://anilist.co/anime/123/cowboy-bebop/reviews');
    expect(short.getAttribute('href')).toBe('/anime/123/');
    expect(subpageSetSpy).not.toHaveBeenCalled();
    expect(subpageAbsSetSpy).not.toHaveBeenCalled();
    expect(shortSetSpy).not.toHaveBeenCalled();

    // Subsequent MutationObserver batch with newly added sub-page and slugged links
    const addedSubpage = document.createElement('a');
    addedSubpage.setAttribute('href', '/anime/123/slug/characters');
    const addedSubpageSpy = vi.spyOn(addedSubpage, 'setAttribute');

    const addedSlugged = document.createElement('a');
    addedSlugged.setAttribute('href', '/character/99/spike-spiegel');
    const addedSluggedSpy = vi.spyOn(addedSlugged, 'setAttribute');

    document.body.appendChild(addedSubpage);
    document.body.appendChild(addedSlugged);

    await Promise.resolve();
    vi.advanceTimersByTime(60);

    expect(addedSubpage.getAttribute('href')).toBe('/anime/123/slug/characters');
    expect(addedSubpageSpy).not.toHaveBeenCalled();
    expect(addedSlugged.getAttribute('href')).toBe('/character/99/');
    expect(addedSluggedSpy).toHaveBeenCalledTimes(1);
  });

  it('strips slug from current location silently on boot and navigation while preserving sub-page locations', async () => {
    history.replaceState({}, '', '/anime/16498/attack-on-titan?tab=overview#cast');
    Settings.set('linkShortenerEnabled', true);

    const navSpy = vi.fn();
    const unsubNav = Core.onNavigate(navSpy);
    try {
      await bootModuleForTest('removeTitle');
      expect(location.pathname + location.search + location.hash).toBe('/anime/16498/?tab=overview#cast');
      expect(navSpy).not.toHaveBeenCalled();

      // Navigating to a sub-page keeps the full path
      history.pushState({}, '', '/anime/16498/attack-on-titan/characters');
      expect(navSpy).toHaveBeenCalledTimes(1);
      expect(location.pathname).toBe('/anime/16498/attack-on-titan/characters');

      // Navigating to a slugged staff page strips it silently without re-firing onNavigate
      navSpy.mockClear();
      history.pushState({}, '', '/staff/105749/hiroshi-kamiya');
      expect(location.pathname).toBe('/staff/105749/');
      expect(navSpy).toHaveBeenCalledTimes(1);
    } finally {
      unsubNav();
    }
  });

  it('stops rewriting links and locations after disposal', async () => {
    vi.useFakeTimers();
    history.replaceState({}, '', '/home');
    Settings.set('linkShortenerEnabled', true);
    await bootModuleForTest('removeTitle');

    disposeFeature('removeTitle');

    const link = document.createElement('a');
    link.setAttribute('href', '/anime/1/cowboy-bebop');
    document.body.appendChild(link);
    await Promise.resolve();
    vi.advanceTimersByTime(60);

    expect(link.getAttribute('href')).toBe('/anime/1/cowboy-bebop');

    history.pushState({}, '', '/anime/1/cowboy-bebop');
    expect(location.pathname).toBe('/anime/1/cowboy-bebop');
  });
});
