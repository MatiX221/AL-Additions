import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/modules/tagFilter';
import { Core } from '../src/core/observer';
import { bootModuleForTest, disposeFeature } from '../src/core/registry';
import { Settings } from '../src/settings/settings';

describe('tagFilter module (BUG-79)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    disposeFeature('tagPercent');
    history.replaceState({}, '', '/');
  });

  it('rewrites initial search URL with history.replaceState under ctx.silently instead of location.replace', async () => {
    history.replaceState({}, '', '/search/anime?genres=Action');
    Settings.set('tagFilterEnabled', true);
    Settings.set('tagPercentage', 50);

    const replaceStateSpy = vi.spyOn(history, 'replaceState');
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const navSpy = vi.fn();
    const unsubNav = Core.onNavigate(navSpy);

    try {
      await bootModuleForTest('tagPercent');

      expect(replaceStateSpy).toHaveBeenCalledTimes(1);
      expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('50');
      expect(new URL(location.href).searchParams.get('genres')).toBe('Action');
      // Initial load runs before Vue boots, so no PopStateEvent or Core navigation loop is emitted
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(navSpy).not.toHaveBeenCalled();
    } finally {
      unsubNav();
    }
  });

  it('preserves an explicit minimumTagRank present on initial load', async () => {
    history.replaceState({}, '', '/search/manga?tags=Isekai&minimumTagRank=80');
    Settings.set('tagFilterEnabled', true);
    Settings.set('tagPercentage', 50);

    const replaceStateSpy = vi.spyOn(history, 'replaceState');
    await bootModuleForTest('tagPercent');

    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('80');
  });

  it('injects minimumTagRank when a filter is selected and preserves manual slider edits across updates', async () => {
    history.replaceState({}, '', '/search/anime');
    Settings.set('tagFilterEnabled', true);
    Settings.set('tagPercentage', 65);

    await bootModuleForTest('tagPercent');
    expect(location.search).toBe('');

    const popstateEvents: PopStateEvent[] = [];
    const onPopstate = (e: Event) => popstateEvents.push(e as PopStateEvent);
    window.addEventListener('popstate', onPopstate);
    const navSpy = vi.fn();
    const unsubNav = Core.onNavigate(navSpy);

    try {
      // User selects a genre in the SPA
      history.pushState({}, '', '/search/anime?genres=Action');
      expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('65');
      expect(popstateEvents).toHaveLength(1);
      // Rewriting under ctx.silently must not trigger a second Core navigation
      expect(navSpy).toHaveBeenCalledTimes(1);

      // User drags the Minimum Tag Rank slider to 80
      navSpy.mockClear();
      popstateEvents.length = 0;
      history.pushState({}, '', '/search/anime?genres=Action&minimumTagRank=80');
      expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('80');
      expect(popstateEvents).toHaveLength(0);
      expect(navSpy).toHaveBeenCalledTimes(1);

      // User adds a tag while slider is at 80 — 80 stays preserved
      history.pushState({}, '', '/search/anime?genres=Action&tags=Isekai&minimumTagRank=80');
      expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('80');

      // User resets slider to default (AniList removes minimumTagRank) within the same filter session
      history.pushState({}, '', '/search/anime?genres=Action&tags=Isekai');
      expect(new URL(location.href).searchParams.has('minimumTagRank')).toBe(false);

      // User clears all genre/tag filters, then starts a new filter selection
      history.pushState({}, '', '/search/anime');
      expect(new URL(location.href).searchParams.has('minimumTagRank')).toBe(false);

      history.pushState({}, '', '/search/anime?tags=Seinen');
      expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('65');
      expect(popstateEvents).toHaveLength(1);
    } finally {
      unsubNav();
      window.removeEventListener('popstate', onPopstate);
    }
  });

  it('resets filter session when switching between /search/anime and /search/manga or leaving search', async () => {
    history.replaceState({}, '', '/search/anime?genres=Action');
    Settings.set('tagFilterEnabled', true);
    Settings.set('tagPercentage', 50);

    await bootModuleForTest('tagPercent');
    expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('50');

    // User sets slider to 80 on anime search
    history.pushState({}, '', '/search/anime?genres=Action&minimumTagRank=80');
    expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('80');

    // Switching to manga search with a new selection starts a fresh filter session
    history.pushState({}, '', '/search/manga?tags=Drama');
    expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('50');

    // Leaving search and returning starts a fresh filter session
    history.pushState({}, '', '/anime/1');
    history.pushState({}, '', '/search/anime?genres=Comedy');
    expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('50');
  });

  it('does not trigger on exclusion params or empty values alone, but triggers when an active genre/tag is present', async () => {
    history.replaceState({}, '', '/search/anime?excludeGenres=Horror&excludeTags=Harem&genres=');
    Settings.set('tagFilterEnabled', true);
    Settings.set('tagPercentage', 50);

    await bootModuleForTest('tagPercent');
    expect(new URL(location.href).searchParams.has('minimumTagRank')).toBe(false);

    // Adding an active genre triggers minimumTagRank
    history.pushState({}, '', '/search/anime?excludeTags=Harem&genres=Mystery');
    expect(new URL(location.href).searchParams.get('minimumTagRank')).toBe('50');
  });

  it('ignores non-search routes and stops handling navigation after disposal', async () => {
    history.replaceState({}, '', '/anime/123?tags=Action');
    Settings.set('tagFilterEnabled', true);
    Settings.set('tagPercentage', 50);

    await bootModuleForTest('tagPercent');
    expect(new URL(location.href).searchParams.has('minimumTagRank')).toBe(false);

    disposeFeature('tagPercent');

    history.pushState({}, '', '/search/anime?genres=Action');
    expect(new URL(location.href).searchParams.has('minimumTagRank')).toBe(false);
  });
});
