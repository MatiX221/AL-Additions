import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/modules/mediaInfo';
import { anilistApiClient } from '../src/api/anilist';
import * as scrapers from '../src/api/scrapers';
import { bootModuleForTest, disposeFeature } from '../src/core/registry';
import { Settings } from '../src/settings/settings';

const flushMicrotasks = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

function mountSidebarAnchor(): HTMLElement {
  document.body.innerHTML = '<div class="sidebar"><div class="data"></div></div>';
  return document.querySelector<HTMLElement>('.sidebar')!;
}

function makeMedia(id: number, overrides: Record<string, any> = {}) {
  return {
    id,
    idMal: null,
    format: 'TV',
    title: { userPreferred: `Media ${id}`, english: null, romaji: `Media ${id}`, native: null },
    episodes: 12,
    chapters: null,
    status: 'FINISHED',
    season: 'SPRING',
    seasonYear: 2024,
    nextAiringEpisode: null,
    mediaListEntry: { score: 0, progress: 0, status: 'PLANNING', completedAt: null },
    ...overrides
  };
}

describe('mediaInfo module (BUG-73, BUG-74, BUG-75)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mountSidebarAnchor();
    Settings.set('mediaInfoEnabled', true);
  });

  afterEach(() => {
    disposeFeature('mediaInfo');
    vi.useRealTimers();
    vi.restoreAllMocks();
    history.replaceState({}, '', '/');
  });

  it('BUG-73: allows decrementing progress above estimated released count while capping increments', async () => {
    vi.spyOn(anilistApiClient, 'hasAuth').mockReturnValue(true);
    vi.spyOn(anilistApiClient, 'viewer').mockResolvedValue({ id: 1, name: 'alice', scoreFormat: 'POINT_10' });
    vi.spyOn(anilistApiClient.media, 'get').mockResolvedValue(
      makeMedia(10, {
        format: 'MANGA',
        episodes: null,
        chapters: null,
        status: 'RELEASING',
        mediaListEntry: { score: 0, progress: 55, status: 'CURRENT', completedAt: null }
      }) as any
    );
    vi.spyOn(scrapers, 'externalReleased').mockResolvedValue(50);

    history.replaceState({}, '', '/manga/10');
    await bootModuleForTest('mediaInfo');

    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    const panel = document.getElementById('ala-mediaInfo-panel')!;
    expect(panel).not.toBeNull();
    const progressInput = panel.querySelector<HTMLInputElement>('.ala-mi-progress-input')!;
    const minusBtn = panel.querySelector<HTMLButtonElement>('.ala-mi-minus')!;
    const plusBtn = panel.querySelector<HTMLButtonElement>('.ala-mi-plus')!;

    expect(progressInput.value).toBe('55');
    expect(panel.querySelector('.ala-mi-prog-sub')?.textContent).toContain('50 released');

    minusBtn.click();
    expect(progressInput.value).toBe('54');

    plusBtn.click();
    expect(progressInput.value).toBe('54');

    progressInput.value = '49';
    plusBtn.click();
    expect(progressInput.value).toBe('50');
    plusBtn.click();
    expect(progressInput.value).toBe('50');

    progressInput.value = '0';
    minusBtn.click();
    expect(progressInput.value).toBe('0');
  });

  it('BUG-74: rejects blank progress input without coercing to 0', async () => {
    vi.spyOn(anilistApiClient, 'hasAuth').mockReturnValue(true);
    vi.spyOn(anilistApiClient, 'viewer').mockResolvedValue({ id: 1, name: 'alice', scoreFormat: 'POINT_10' });
    vi.spyOn(anilistApiClient.media, 'get').mockResolvedValue(
      makeMedia(20, {
        episodes: 12,
        mediaListEntry: { score: 7, progress: 5, status: 'CURRENT', completedAt: null }
      }) as any
    );
    const saveSpy = vi.spyOn(anilistApiClient.media, 'save').mockResolvedValue({} as any);

    history.replaceState({}, '', '/anime/20');
    await bootModuleForTest('mediaInfo');

    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    const panel = document.getElementById('ala-mediaInfo-panel')!;
    const progressInput = panel.querySelector<HTMLInputElement>('.ala-mi-progress-input')!;
    const saveBtn = panel.querySelector<HTMLButtonElement>('.ala-mi-save')!;

    progressInput.value = '   ';
    progressInput.dispatchEvent(new Event('input'));
    expect(saveBtn.disabled).toBe(false);

    saveBtn.click();
    await flushMicrotasks();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(progressInput);
    expect(saveBtn.textContent).toBe('Save');
    expect(saveBtn.disabled).toBe(false);
  });

  it('BUG-74: does not set COMPLETED/completedAt on score-only edits or REPEATING entries', async () => {
    vi.spyOn(anilistApiClient, 'hasAuth').mockReturnValue(true);
    vi.spyOn(anilistApiClient, 'viewer').mockResolvedValue({ id: 1, name: 'alice', scoreFormat: 'POINT_10' });
    vi.spyOn(anilistApiClient.media, 'get').mockImplementation(async (id) => {
      if (Number(id) === 21) {
        return makeMedia(21, {
          episodes: 12,
          mediaListEntry: { score: 7, progress: 12, status: 'COMPLETED', completedAt: { year: null, month: null, day: null } }
        }) as any;
      }
      return makeMedia(22, {
        episodes: 12,
        mediaListEntry: { score: 8, progress: 11, status: 'REPEATING', completedAt: { year: 2024, month: 1, day: 1 } }
      }) as any;
    });
    const saveSpy = vi.spyOn(anilistApiClient.media, 'save').mockImplementation(async (_id, _type, payload) => ({
      score: payload.score ?? 0,
      progress: payload.progress ?? 0,
      status: payload.status ?? 'COMPLETED',
      completedAt: payload.completedAt ?? null
    }));

    history.replaceState({}, '', '/anime/21');
    await bootModuleForTest('mediaInfo');
    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    let panel = document.getElementById('ala-mediaInfo-panel')!;
    let scoreInput = panel.querySelector<HTMLInputElement>('.ala-mi-score-input')!;
    let saveBtn = panel.querySelector<HTMLButtonElement>('.ala-mi-save')!;

    scoreInput.value = '8';
    scoreInput.dispatchEvent(new Event('input'));
    saveBtn.click();
    await flushMicrotasks();

    expect(saveSpy).toHaveBeenCalledWith(
      21,
      'ANIME',
      {
        score: 8,
        progress: 12,
        status: undefined,
        completedAt: undefined
      },
      { signal: expect.any(AbortSignal) }
    );

    history.pushState({}, '', '/anime/22');
    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    panel = document.getElementById('ala-mediaInfo-panel')!;
    const plusBtn = panel.querySelector<HTMLButtonElement>('.ala-mi-plus')!;
    saveBtn = panel.querySelector<HTMLButtonElement>('.ala-mi-save')!;

    plusBtn.click();
    saveBtn.click();
    await flushMicrotasks();

    expect(saveSpy).toHaveBeenLastCalledWith(
      22,
      'ANIME',
      {
        score: 8,
        progress: 12,
        status: undefined,
        completedAt: undefined
      },
      { signal: expect.any(AbortSignal) }
    );
  });

  it('BUG-74: falls back to rendered scoreFormat when viewer() returns null during save', async () => {
    vi.spyOn(anilistApiClient, 'hasAuth').mockReturnValue(true);
    const viewerSpy = vi
      .spyOn(anilistApiClient, 'viewer')
      .mockResolvedValueOnce({ id: 1, name: 'alice', scoreFormat: 'POINT_100' })
      .mockResolvedValueOnce(null);
    vi.spyOn(anilistApiClient.media, 'get').mockResolvedValue(
      makeMedia(23, {
        episodes: 12,
        mediaListEntry: { score: 80, progress: 3, status: 'CURRENT', completedAt: null }
      }) as any
    );
    const saveSpy = vi.spyOn(anilistApiClient.media, 'save').mockResolvedValue({
      score: 95,
      progress: 3,
      status: 'CURRENT',
      completedAt: null
    });

    history.replaceState({}, '', '/anime/23');
    await bootModuleForTest('mediaInfo');
    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    const panel = document.getElementById('ala-mediaInfo-panel')!;
    const scoreInput = panel.querySelector<HTMLInputElement>('.ala-mi-score-input')!;
    const saveBtn = panel.querySelector<HTMLButtonElement>('.ala-mi-save')!;

    scoreInput.value = '95';
    scoreInput.dispatchEvent(new Event('input'));
    saveBtn.click();
    await flushMicrotasks();

    expect(viewerSpy).toHaveBeenCalledTimes(2);
    expect(saveSpy).toHaveBeenCalledWith(
      23,
      'ANIME',
      {
        score: 95,
        progress: 3,
        status: undefined,
        completedAt: undefined
      },
      { signal: expect.any(AbortSignal) }
    );
  });

  it('BUG-75: renders /anime/2 panel when navigating /anime/1 -> /anime/2 mid-save', async () => {
    vi.spyOn(anilistApiClient, 'hasAuth').mockReturnValue(true);
    vi.spyOn(anilistApiClient, 'viewer').mockResolvedValue({ id: 1, name: 'alice', scoreFormat: 'POINT_10' });
    const getSpy = vi.spyOn(anilistApiClient.media, 'get').mockImplementation(async (id) => {
      if (Number(id) === 1) {
        return makeMedia(1, {
          episodes: 12,
          mediaListEntry: { score: 7, progress: 2, status: 'CURRENT', completedAt: null }
        }) as any;
      }
      return makeMedia(2, {
        episodes: 24,
        mediaListEntry: { score: 9, progress: 8, status: 'CURRENT', completedAt: null }
      }) as any;
    });

    let resolveSave!: (value: any) => void;
    const savePromise = new Promise<any>((resolve) => {
      resolveSave = resolve;
    });
    vi.spyOn(anilistApiClient.media, 'save').mockReturnValue(savePromise);

    history.replaceState({}, '', '/anime/1');
    await bootModuleForTest('mediaInfo');
    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    const panel1 = document.getElementById('ala-mediaInfo-panel')!;
    panel1.querySelector<HTMLButtonElement>('.ala-mi-plus')!.click();
    panel1.querySelector<HTMLButtonElement>('.ala-mi-save')!.click();
    await flushMicrotasks(2);

    // Navigate to /anime/2 while save(1) is still in-flight
    history.pushState({}, '', '/anime/2');
    expect(document.getElementById('ala-mediaInfo-panel')).toBeNull();

    // Even after route timer fires while saving is true, rendering must not be dropped
    vi.advanceTimersByTime(700);
    await flushMicrotasks();
    expect(document.getElementById('ala-mediaInfo-panel')).toBeNull();

    // Finish save(1) — /anime/2 should immediately render
    resolveSave({ score: 7, progress: 3, status: 'CURRENT', completedAt: null });
    await flushMicrotasks();

    expect(getSpy).toHaveBeenCalledWith(2, 'ANIME', { throwAuth: true, signal: expect.any(AbortSignal) });
    const panel2 = document.getElementById('ala-mediaInfo-panel')!;
    expect(panel2).not.toBeNull();
    expect(panel2.querySelector<HTMLInputElement>('.ala-mi-score-input')!.value).toBe('9');
    expect(panel2.querySelector<HTMLInputElement>('.ala-mi-progress-input')!.value).toBe('8');
  });

  it('BUG-75: cancels route-scoped saveBtn and renderConnect timers on navigation', async () => {
    const authSpy = vi.spyOn(anilistApiClient, 'hasAuth').mockReturnValue(true);
    vi.spyOn(anilistApiClient, 'viewer').mockResolvedValue({ id: 1, name: 'alice', scoreFormat: 'POINT_10' });
    const getSpy = vi.spyOn(anilistApiClient.media, 'get').mockResolvedValue(
      makeMedia(30, {
        episodes: 12,
        mediaListEntry: { score: 7, progress: 2, status: 'CURRENT', completedAt: null }
      }) as any
    );
    vi.spyOn(anilistApiClient.media, 'save').mockResolvedValue({
      score: 7,
      progress: 3,
      status: 'CURRENT',
      completedAt: null
    });

    history.replaceState({}, '', '/anime/30');
    await bootModuleForTest('mediaInfo');
    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    const panel = document.getElementById('ala-mediaInfo-panel')!;
    const saveBtn = panel.querySelector<HTMLButtonElement>('.ala-mi-save')!;
    panel.querySelector<HTMLButtonElement>('.ala-mi-plus')!.click();
    saveBtn.click();
    await flushMicrotasks();

    expect(saveBtn.classList.contains('is-saved')).toBe(true);
    expect(saveBtn.textContent).toBe('Saved');

    history.pushState({}, '', '/home');
    vi.advanceTimersByTime(2500);
    expect(saveBtn.classList.contains('is-saved')).toBe(true);
    expect(saveBtn.textContent).toBe('Saved');

    // Now test renderConnect 3000ms timer cancellation on route exit
    authSpy.mockReturnValue(false);
    getSpy.mockClear();
    history.pushState({}, '', '/anime/31');
    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    const connectPanel = document.getElementById('ala-mediaInfo-panel')!;
    expect(connectPanel?.dataset.mode).toBe('connect');

    history.pushState({}, '', '/home');
    authSpy.mockReturnValue(true);
    vi.advanceTimersByTime(3500);
    await flushMicrotasks();

    expect(getSpy).not.toHaveBeenCalled();
  });

  it('IMP-12: passes ctx.http and rc.signal into externalReleased and aborts signal on navigation', async () => {
    vi.spyOn(anilistApiClient, 'hasAuth').mockReturnValue(true);
    vi.spyOn(anilistApiClient, 'viewer').mockResolvedValue({ id: 1, name: 'alice', scoreFormat: 'POINT_10' });
    vi.spyOn(anilistApiClient.media, 'get').mockResolvedValue(
      makeMedia(40, {
        format: 'MANGA',
        episodes: null,
        chapters: null,
        status: 'RELEASING',
        mediaListEntry: { score: 0, progress: 1, status: 'CURRENT', completedAt: null }
      }) as any
    );

    let capturedOpts: { http?: any; signal?: AbortSignal } | undefined;
    let rejectLookup!: (err: unknown) => void;
    const extSpy = vi.spyOn(scrapers, 'externalReleased').mockImplementation((_info, opts) => {
      capturedOpts = opts;
      return new Promise<number | null>((_resolve, reject) => {
        rejectLookup = reject;
      });
    });

    history.replaceState({}, '', '/manga/40');
    await bootModuleForTest('mediaInfo');
    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    expect(extSpy).toHaveBeenCalledTimes(1);
    expect(capturedOpts?.http).toBeDefined();
    expect(typeof capturedOpts?.http?.json).toBe('function');
    expect(typeof capturedOpts?.http?.text).toBe('function');
    expect(capturedOpts?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedOpts?.signal?.aborted).toBe(false);

    history.pushState({}, '', '/home');
    expect(capturedOpts?.signal?.aborted).toBe(true);

    rejectLookup(new DOMException('Request aborted', 'AbortError'));
    await flushMicrotasks();
    expect(document.getElementById('ala-mediaInfo-panel')).toBeNull();
  });

  it('BUG-46: aborts pending media.get and viewer reads on route exit while save() survives navigation', async () => {
    vi.spyOn(anilistApiClient, 'hasAuth').mockReturnValue(true);

    let getSignal: AbortSignal | undefined;
    const getSpy = vi
      .spyOn(anilistApiClient.media, 'get')
      .mockImplementationOnce((_id, _type, opts) => {
        getSignal = opts?.signal;
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')));
        });
      })
      .mockResolvedValueOnce(
        makeMedia(51, {
          episodes: 12,
          mediaListEntry: { score: 0, progress: 1, status: 'CURRENT', completedAt: null }
        }) as any
      )
      .mockImplementation(async (id) =>
        makeMedia(Number(id), {
          episodes: 12,
          mediaListEntry: { score: 7, progress: 2, status: 'CURRENT', completedAt: null }
        }) as any
      );

    let viewerSignal: AbortSignal | undefined;
    const viewerSpy = vi
      .spyOn(anilistApiClient, 'viewer')
      .mockImplementationOnce((_forceFresh, opts) => {
        viewerSignal = opts?.signal;
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')));
        });
      })
      .mockResolvedValue({ id: 1, name: 'alice', scoreFormat: 'POINT_10' });

    let saveSignal: AbortSignal | undefined;
    let resolveSave!: (value: any) => void;
    const saveSpy = vi.spyOn(anilistApiClient.media, 'save').mockImplementation((_id, _type, _patch, opts) => {
      saveSignal = opts?.signal;
      return new Promise((resolve) => {
        resolveSave = resolve;
      });
    });

    // 1. Route exit aborts pending media.get
    history.replaceState({}, '', '/anime/50');
    await bootModuleForTest('mediaInfo');
    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSignal).toBeInstanceOf(AbortSignal);
    expect(getSignal?.aborted).toBe(false);

    history.pushState({}, '', '/home');
    expect(getSignal?.aborted).toBe(true);
    await flushMicrotasks();

    // 2. Route exit aborts pending viewer() read in render()
    history.pushState({}, '', '/anime/51');
    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    expect(viewerSpy).toHaveBeenCalledTimes(1);
    expect(viewerSignal).toBeInstanceOf(AbortSignal);
    expect(viewerSignal?.aborted).toBe(false);

    history.pushState({}, '', '/home');
    expect(viewerSignal?.aborted).toBe(true);
    await flushMicrotasks();

    // 3. save() uses ctx.api so it survives quick navigation until module disposal
    history.pushState({}, '', '/anime/52');
    vi.advanceTimersByTime(600);
    await flushMicrotasks();

    const panel52 = document.getElementById('ala-mediaInfo-panel')!;
    panel52.querySelector<HTMLButtonElement>('.ala-mi-plus')!.click();
    panel52.querySelector<HTMLButtonElement>('.ala-mi-save')!.click();
    await flushMicrotasks(2);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSignal).toBeInstanceOf(AbortSignal);
    expect(saveSignal?.aborted).toBe(false);

    history.pushState({}, '', '/anime/53');
    expect(saveSignal?.aborted).toBe(false);

    resolveSave({ score: 7, progress: 3, status: 'CURRENT', completedAt: null });
    await flushMicrotasks();

    const panel53 = document.getElementById('ala-mediaInfo-panel')!;
    expect(panel53).not.toBeNull();

    disposeFeature('mediaInfo');
    expect(saveSignal?.aborted).toBe(true);
  });
});
