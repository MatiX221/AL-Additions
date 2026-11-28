import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/modules/airingDots';
import { anilistApiClient } from '../src/api/anilist';
import { bootModuleForTest, createModuleHost, disposeFeature } from '../src/core/registry';
import { Settings } from '../src/settings/settings';

const CACHE_KEY = 'ala_mod_behindDots_daiya-anilist-airing-cache-v5';

const flushMicrotasks = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

const getCacheWriteCount = (): number =>
  (vi.mocked(globalThis.GM_setValue).mock.calls as Array<[string, unknown]>).filter(([k]) => k === CACHE_KEY).length;

function makeWatchingListDom(entries: Array<{ id: number; progress: number; releasing?: boolean }>): void {
  const rows = entries
    .map(
      ({ id, progress, releasing = true }) => `
      <div class="entry">
        <a href="/anime/${id}">Anime ${id}</a>
        <span class="progress">${progress}/12</span>
        ${releasing ? '<span class="release-status RELEASING"></span>' : ''}
      </div>`
    )
    .join('');

  document.body.innerHTML = `
    <div class="list-wrap">
      <h3 class="section-name">Watching</h3>
      <div class="list-entries">${rows}</div>
    </div>
  `;
}

describe('airingDots module (BUG-59, BUG-60)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    disposeFeature('behindDots');
    history.replaceState({}, '', '/');
  });

  it('BUG-59: aborts in-flight query updates cleanly when disabled mid-query with zero DOM or storage writes', async () => {
    vi.useFakeTimers();
    makeWatchingListDom([{ id: 101, progress: 2 }]);
    history.replaceState({}, '', '/user/Alice/animelist');
    Settings.set('behindDotsEnabled', true);

    let resolveQuery!: (val: any) => void;
    const queryDeferred = new Promise((res) => {
      resolveQuery = res;
    });
    const querySpy = vi.spyOn(anilistApiClient, 'query').mockReturnValue(queryDeferred as Promise<any>);

    await bootModuleForTest('behindDots');
    expect(querySpy).toHaveBeenCalledTimes(1);

    // Disable mid-query before response arrives
    Settings.set('behindDotsEnabled', false);
    createModuleHost().reload(['behindDots']);
    vi.mocked(globalThis.GM_setValue).mockClear();

    // Resolve the in-flight query after disposal
    resolveQuery({
      Page: {
        media: [
          {
            id: 101,
            status: 'RELEASING',
            nextAiringEpisode: { episode: 6, airingAt: Math.floor(Date.now() / 1000) + 3600, timeUntilAiring: 3600 }
          }
        ]
      }
    });
    await flushMicrotasks();
    vi.advanceTimersByTime(2000);

    expect(document.querySelectorAll('.daiya-behind-dot').length).toBe(0);
    expect(getCacheWriteCount()).toBe(0);
    expect(globalThis.GM_getValue(CACHE_KEY)).toBeUndefined();
  });

  it('BUG-59: cancels pending debounced refresh on disable and route exit with zero DOM or storage writes', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    // Seed cache for entry 201 so initial scan does not query
    globalThis.GM_setValue(
      CACHE_KEY,
      JSON.stringify({
        '201': { status: 'RELEASING', updated: now, aired: 2, nextEpisode: 3, nextCheck: now + 60_000 }
      })
    );
    makeWatchingListDom([{ id: 201, progress: 2 }]);
    history.replaceState({}, '', '/user/Alice/animelist');
    Settings.set('behindDotsEnabled', true);

    const querySpy = vi.spyOn(anilistApiClient, 'query').mockResolvedValue({
      Page: {
        media: [
          {
            id: 202,
            status: 'RELEASING',
            nextAiringEpisode: { episode: 5, airingAt: Math.floor(now / 1000) + 3600, timeUntilAiring: 3600 }
          }
        ]
      }
    });

    await bootModuleForTest('behindDots');
    expect(querySpy).not.toHaveBeenCalled();

    // Trigger debounced refresh (100ms), then add an uncached entry and disable before debounce fires
    const entry = document.querySelector('.entry')!;
    entry.dispatchEvent(new Event('click', { bubbles: true }));
    makeWatchingListDom([{ id: 202, progress: 1 }]);

    vi.advanceTimersByTime(50);
    Settings.set('behindDotsEnabled', false);
    createModuleHost().reload(['behindDots']);
    vi.mocked(globalThis.GM_setValue).mockClear();

    vi.advanceTimersByTime(2000);
    await flushMicrotasks();

    expect(querySpy).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.daiya-behind-dot').length).toBe(0);
    expect(getCacheWriteCount()).toBe(0);

    // Re-enable and verify route navigation mid-debounce also cancels refresh
    makeWatchingListDom([{ id: 201, progress: 2 }]);
    Settings.set('behindDotsEnabled', true);
    createModuleHost().reload(['behindDots']);
    await flushMicrotasks();

    document.querySelector('.entry')!.dispatchEvent(new Event('click', { bubbles: true }));
    makeWatchingListDom([{ id: 202, progress: 1 }]);

    vi.advanceTimersByTime(50);
    history.pushState({}, '', '/home');
    vi.mocked(globalThis.GM_setValue).mockClear();

    vi.advanceTimersByTime(2000);
    await flushMicrotasks();

    expect(querySpy).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.daiya-behind-dot').length).toBe(0);
    expect(getCacheWriteCount()).toBe(0);
  });

  it('BUG-59: ignores in-flight query resolution after navigating away from animelist', async () => {
    vi.useFakeTimers();
    makeWatchingListDom([{ id: 301, progress: 1 }]);
    history.replaceState({}, '', '/user/Alice/animelist');
    Settings.set('behindDotsEnabled', true);

    let resolveQuery!: (val: any) => void;
    const queryDeferred = new Promise((res) => {
      resolveQuery = res;
    });
    vi.spyOn(anilistApiClient, 'query').mockReturnValue(queryDeferred as Promise<any>);

    await bootModuleForTest('behindDots');

    // Navigate away while query is still in flight
    history.pushState({}, '', '/anime/301');
    vi.mocked(globalThis.GM_setValue).mockClear();

    resolveQuery({
      Page: {
        media: [
          {
            id: 301,
            status: 'RELEASING',
            nextAiringEpisode: { episode: 4, airingAt: Math.floor(Date.now() / 1000) + 3600, timeUntilAiring: 3600 }
          }
        ]
      }
    });
    await flushMicrotasks();
    vi.advanceTimersByTime(2000);

    expect(document.querySelectorAll('.daiya-behind-dot').length).toBe(0);
    expect(getCacheWriteCount()).toBe(0);
  });

  it('BUG-60: ignores /user/Alice/animelist/compare while matching /user/Alice/animelist and /user/Alice/animelist/', async () => {
    const querySpy = vi.spyOn(anilistApiClient, 'query').mockResolvedValue({
      Page: {
        media: [
          {
            id: 401,
            status: 'RELEASING',
            nextAiringEpisode: { episode: 5, airingAt: Math.floor(Date.now() / 1000) + 3600, timeUntilAiring: 3600 }
          }
        ]
      }
    });

    makeWatchingListDom([{ id: 401, progress: 1 }]);
    history.replaceState({}, '', '/user/Alice/animelist/compare');
    Settings.set('behindDotsEnabled', true);

    await bootModuleForTest('behindDots');
    await flushMicrotasks();

    expect(querySpy).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.daiya-behind-dot').length).toBe(0);

    // Navigate to /user/Alice/animelist -> should activate and mark dot
    history.pushState({}, '', '/user/Alice/animelist');
    await flushMicrotasks();

    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.daiya-behind-dot').length).toBe(1);

    // Reset DOM/cache and verify trailing slash /user/Alice/animelist/ also matches
    disposeFeature('behindDots');
    globalThis.GM_deleteValue(CACHE_KEY);
    querySpy.mockClear();
    makeWatchingListDom([{ id: 401, progress: 1 }]);
    history.replaceState({}, '', '/user/Alice/animelist/');

    await bootModuleForTest('behindDots');
    await flushMicrotasks();

    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.daiya-behind-dot').length).toBe(1);
  });

  it('BUG-60: startList only schedules refresh timers for IDs rendered in watchingEntries()', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    globalThis.GM_setValue(
      CACHE_KEY,
      JSON.stringify({
        '501': { status: 'RELEASING', updated: now, aired: 3, nextEpisode: 4, nextCheck: now + 30_000 },
        '999': { status: 'RELEASING', updated: now, aired: 2, nextEpisode: 3, nextCheck: now + 10_000 }
      })
    );

    // Only 501 is rendered on the page; 999 is an off-page cached anime
    makeWatchingListDom([{ id: 501, progress: 1 }]);
    history.replaceState({}, '', '/user/Alice/animelist');
    Settings.set('behindDotsEnabled', true);

    const querySpy = vi.spyOn(anilistApiClient, 'query').mockResolvedValue({
      Page: {
        media: [
          {
            id: 501,
            status: 'RELEASING',
            nextAiringEpisode: { episode: 5, airingAt: Math.floor(now / 1000) + 3600, timeUntilAiring: 3600 }
          }
        ]
      }
    });

    await bootModuleForTest('behindDots');
    expect(querySpy).not.toHaveBeenCalled();

    // Advance past off-page 999's nextCheck (10s), before on-page 501's nextCheck (30s)
    vi.advanceTimersByTime(15_000);
    await flushMicrotasks();
    expect(querySpy).not.toHaveBeenCalled();

    // Advance past on-page 501's nextCheck (30s)
    vi.advanceTimersByTime(20_000);
    await flushMicrotasks();
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledWith(expect.any(String), { ids: [501] }, { signal: expect.any(AbortSignal) });
  });

  it('BUG-34: aborts pending query on animelist-to-animelist transition and re-fetches shared IDs cleanly', async () => {
    vi.useFakeTimers();
    makeWatchingListDom([{ id: 601, progress: 1 }]);
    history.replaceState({}, '', '/user/Alice/animelist');
    Settings.set('behindDotsEnabled', true);

    const signals: AbortSignal[] = [];
    let resolveAlice!: (val: any) => void;
    let resolveBob!: (val: any) => void;
    const aliceDeferred = new Promise((res) => {
      resolveAlice = res;
    });
    const bobDeferred = new Promise((res) => {
      resolveBob = res;
    });

    const querySpy = vi
      .spyOn(anilistApiClient, 'query')
      .mockImplementationOnce((_q, _vars, opts) => {
        if (typeof opts === 'object' && opts?.signal) signals.push(opts.signal);
        return aliceDeferred as Promise<any>;
      })
      .mockImplementationOnce((_q, _vars, opts) => {
        if (typeof opts === 'object' && opts?.signal) signals.push(opts.signal);
        return bobDeferred as Promise<any>;
      });

    await bootModuleForTest('behindDots');
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0].aborted).toBe(false);

    // Navigate to Bob's animelist (with the same anime ID 601) while Alice's query is still pending
    makeWatchingListDom([{ id: 601, progress: 1 }]);
    history.pushState({}, '', '/user/Bob/animelist');

    expect(signals[0].aborted).toBe(true);
    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(querySpy).toHaveBeenNthCalledWith(2, expect.any(String), { ids: [601] }, { signal: expect.any(AbortSignal) });
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[1].aborted).toBe(false);

    // Settle Alice's stale query first; its .finally() must not disturb Bob's state or paint
    vi.mocked(globalThis.GM_setValue).mockClear();
    resolveAlice({ Page: { media: [] } });
    await flushMicrotasks();
    vi.advanceTimersByTime(2000);
    expect(getCacheWriteCount()).toBe(0);
    expect(document.querySelectorAll('.daiya-behind-dot').length).toBe(0);

    // Resolve Bob's query and verify dot renders for shared ID 601
    resolveBob({
      Page: {
        media: [
          {
            id: 601,
            status: 'RELEASING',
            nextAiringEpisode: { episode: 5, airingAt: Math.floor(Date.now() / 1000) + 3600, timeUntilAiring: 3600 }
          }
        ]
      }
    });
    await flushMicrotasks();
    vi.advanceTimersByTime(2000);

    expect(document.querySelectorAll('.daiya-behind-dot').length).toBe(1);
    expect(getCacheWriteCount()).toBeGreaterThan(0);
  });
});
