import { describe, it, expect, vi } from 'vitest';
import {
  normalizeStatus,
  getEntryMediaId,
  getEntryData,
  compareEntries,
  type EntryData
} from '../src/modules/compareView';
import { createCompareState } from '../src/modules/compareView/data';
import { applySort, cleanupCompareView, setupCompareView } from '../src/modules/compareView/dom';
import { loadAllEntriesViaMediaList } from '../src/modules/compareView/loader';
import { AniList } from '../src/api/anilist';

describe('compareView: normalizeStatus', () => {
  it('handles empty, null, or undefined values with fallback', () => {
    expect(normalizeStatus('')).toBe('Planning');
    expect(normalizeStatus(null as any)).toBe('Planning');
    expect(normalizeStatus(undefined as any)).toBe('Planning');
  });

  it('normalizes planning statuses', () => {
    expect(normalizeStatus('Planning')).toBe('Planning');
    expect(normalizeStatus('Plan to Watch')).toBe('Planning');
    expect(normalizeStatus('PLANNING')).toBe('Planning');
  });

  it('normalizes completed statuses', () => {
    expect(normalizeStatus('Completed')).toBe('Completed');
    expect(normalizeStatus('COMPLETE')).toBe('Completed');
  });

  it('normalizes current / watching / reading / repeating statuses', () => {
    expect(normalizeStatus('Current')).toBe('Current');
    expect(normalizeStatus('Watching')).toBe('Current');
    expect(normalizeStatus('Reading')).toBe('Current');
    expect(normalizeStatus('Repeating')).toBe('Current');
  });

  it('normalizes paused / on-hold statuses', () => {
    expect(normalizeStatus('Paused')).toBe('Paused');
    expect(normalizeStatus('On Hold')).toBe('Paused');
    expect(normalizeStatus('HOLD')).toBe('Paused');
  });

  it('normalizes dropped statuses', () => {
    expect(normalizeStatus('Dropped')).toBe('Dropped');
    expect(normalizeStatus('DROP')).toBe('Dropped');
  });
});

describe('compareView: getEntryMediaId', () => {
  it('extracts numeric mediaId from anime or manga links', () => {
    const el1 = document.createElement('div');
    el1.innerHTML = `<div class="title"><a href="/anime/12345/shingeki-no-kyojin" class="title">AOT</a></div>`;
    expect(getEntryMediaId(el1)).toBe(12345);

    const el2 = document.createElement('div');
    el2.innerHTML = `<div class="title"><a href="/manga/99999" class="title">Manga</a></div>`;
    expect(getEntryMediaId(el2)).toBe(99999);
  });

  it('returns null if link or id is missing', () => {
    const el = document.createElement('div');
    el.innerHTML = `<div class="title"><span>No Link</span></div>`;
    expect(getEntryMediaId(el)).toBeNull();

    const el2 = document.createElement('div');
    el2.innerHTML = `<div class="title"><a href="/user/someone">User</a></div>`;
    expect(getEntryMediaId(el2)).toBeNull();
  });
});

describe('compareView: getEntryData', () => {
  it('extracts title, scores, and normalized statuses from DOM element', () => {
    const row = document.createElement('div');
    row.innerHTML = `
      <div class="title"><a href="/anime/101" class="title">Frieren</a></div>
      <div class="score" label="Score" score="9.5"><span>9.5</span></div>
      <div class="score" score="8"><span>8</span></div>
      <div class="status" label="Your Status"><span>Completed</span></div>
      <div class="status"><span>Watching</span></div>
    `;

    const data = getEntryData(row);
    expect(data.title).toBe('Frieren');
    expect(data.yourScore).toBe(9.5);
    expect(data.otherScore).toBe(8);
    expect(data.yourStatus).toBe('Completed');
    expect(data.otherStatus).toBe('Current');
  });

  it('correctly parses 0 scores and unscored/unwatched entries without defaulting to empty', () => {
    const row = document.createElement('div');
    row.innerHTML = `
      <div class="title"><a href="/anime/202" class="title">Unwatched Show</a></div>
      <div class="score" label="Score" score="0"><span>0</span></div>
      <div class="score" score="0"><span>0</span></div>
      <div class="status" label="Your Status"><span>Planning</span></div>
      <div class="status"><span>Planning</span></div>
    `;

    const data = getEntryData(row);
    expect(data.yourScore).toBe(0);
    expect(data.otherScore).toBe(0);
    expect(data.yourStatus).toBe('Planning');
    expect(data.otherStatus).toBe('Planning');
  });

  it('falls back to 0 when score attributes and texts are non-numeric or empty', () => {
    const row = document.createElement('div');
    row.innerHTML = `
      <div class="title"><a href="/anime/303" class="title">Empty Scores</a></div>
      <div class="score" label="Score"><span>-</span></div>
      <div class="score"><span></span></div>
      <div class="status" label="Your Status"><span>Unknown</span></div>
      <div class="status"><span>Unknown</span></div>
    `;

    const data = getEntryData(row);
    expect(data.yourScore).toBe(0);
    expect(data.otherScore).toBe(0);
  });
});

describe('compareView: compareEntries', () => {
  const entryA: EntryData = {
    el: document.createElement('div'),
    title: 'Attack on Titan',
    yourScore: 9,
    otherScore: 8,
    yourStatus: 'Completed',
    otherStatus: 'Completed'
  };

  const entryB: EntryData = {
    el: document.createElement('div'),
    title: 'Bleach',
    yourScore: 7,
    otherScore: 8,
    yourStatus: 'Current',
    otherStatus: 'Completed'
  };

  const entryC: EntryData = {
    el: document.createElement('div'),
    title: 'Chainsaw Man',
    yourScore: 0,
    otherScore: 0,
    yourStatus: 'Planning',
    otherStatus: 'Planning'
  };

  it('sorts by title alphabetically ascending and descending', () => {
    expect(compareEntries(entryA, entryB, 'title', 'asc')).toBeLessThan(0);
    expect(compareEntries(entryA, entryB, 'title', 'desc')).toBeGreaterThan(0);
  });

  it('sorts by yourScore ascending and descending', () => {
    expect(compareEntries(entryA, entryB, 'yourScore', 'desc')).toBeLessThan(0);
    expect(compareEntries(entryA, entryB, 'yourScore', 'asc')).toBeGreaterThan(0);
    expect(compareEntries(entryB, entryC, 'yourScore', 'desc')).toBeLessThan(0);
  });

  it('breaks ties using title when otherScore is equal', () => {
    expect(compareEntries(entryA, entryB, 'otherScore', 'desc')).toBeLessThan(0);
    expect(compareEntries(entryB, entryA, 'otherScore', 'desc')).toBeGreaterThan(0);
  });
});

describe('compareView: DOM structure & score formatting', () => {
  it('correctly handles zero and non-zero scores without empty labels', () => {
    const row = document.createElement('div');
    row.className = 'entry';
    const yourScore = 0;
    const otherScore = 8.5;
    const yourStatus = 'Completed';
    const otherStatus = 'Planning';
    const displayOtherName = 'MysticDaiya';

    row.innerHTML = `
      <div class="title">
        <a href="/anime/100/" class="">Sample Title</a>
      </div>
      <div class="score" label="Score" score="${yourScore}"><span>${yourScore > 0 ? yourScore : '0'}</span></div>
      <div class="score" label="${displayOtherName}'s Score" score="${otherScore}"><span>${otherScore > 0 ? otherScore : '0'}</span></div>
      <div class="status" label="Your Status"><span>${yourStatus}</span></div>
      <div class="status" label="${displayOtherName}'s Status"><span>${otherStatus}</span></div>
    `;

    const scores = row.querySelectorAll<HTMLElement>('.score');
    expect(scores[0].querySelector('span')?.textContent).toBe('0');
    expect(scores[1].querySelector('span')?.textContent).toBe('8.5');

    const data = getEntryData(row);
    expect(data.yourScore).toBe(0);
    expect(data.otherScore).toBe(8.5);
    expect(data.yourStatus).toBe('Completed');
    expect(data.otherStatus).toBe('Planning');
  });

  it('preserves 0 in score text when native AniList items are empty', () => {
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `
      <div class="score" label="Score" score="0">   </div>
      <div class="score" label="MysticDaiya's Score" score="0"></div>
    `;

    row.querySelectorAll<HTMLElement>('.score').forEach((scoreEl) => {
      const text = scoreEl.textContent?.trim();
      if (!text || text === '') {
        scoreEl.textContent = '0';
      }
    });

    const scores = row.querySelectorAll<HTMLElement>('.score');
    expect(scores[0].textContent).toBe('0');
    expect(scores[1].textContent).toBe('0');
  });

  it('correctly distinguishes your and other score/status when label attributes are absent', () => {
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `
      <div class="title"><a href="/anime/500">Hunter x Hunter</a></div>
      <div class="score" score="9"><span>9</span></div>
      <div class="score" score="7"><span>7</span></div>
      <div class="status"><span>Completed</span></div>
      <div class="status"><span>Paused</span></div>
    `;

    const data = getEntryData(row);
    expect(data.yourScore).toBe(9);
    expect(data.otherScore).toBe(7);
    expect(data.yourStatus).toBe('Completed');
    expect(data.otherStatus).toBe('Paused');
  });

  it('safely escapes special characters in usernames in compare view markup', () => {
    const rawName = 'User" <script>alert(1)</script>';
    const safeName = rawName.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

    const row = document.createElement('div');
    row.innerHTML = `
      <div class="score" label="${safeName}'s Score" score="8"><span class="ala-header-label">${safeName}'s Score</span></div>
      <div class="status" label="${safeName}'s Status"><span>Completed</span></div>
    `;

    expect(row.querySelector('script')).toBeNull();
    const scoreEl = row.querySelector('.score');
    expect(scoreEl?.getAttribute('label')).toBe('User" <script>alert(1)</script>\'s Score');
    expect(scoreEl?.querySelector('.ala-header-label')?.textContent).toBe('User" <script>alert(1)</script>\'s Score');
  });
});

describe('compareView: ctx.session integration & ctx.log usage', () => {
  it('uses ctx.session.peek({ reconcile: true }) and logs via ctx.log.debug and ctx.log.error', async () => {
    history.replaceState({}, '', '/user/OtherUser/animelist/compare');
    const compareRoot = document.createElement('div');
    compareRoot.className = 'compare';
    const sidebar = document.createElement('div');
    document.body.append(compareRoot, sidebar);

    const debugLog = vi.fn();
    const errorLog = vi.fn();
    const peekSpy = vi.spyOn(AniList.session, 'peek');

    const makeMockCtx = () =>
      ({
        session: AniList.session,
        hooks: {
          getCacheBridge: () => null,
          setPrefetchPaused: () => () => {}
        },
        log: {
          label: 'Compare View',
          title: 'Compare View Debug',
          canDebug: true,
          enabled: () => true,
          debug: debugLog,
          warn: vi.fn(),
          error: errorLog,
          channel: vi.fn()
        }
      }) as any;

    const makeMockRc = (overrides: Record<string, any> = {}) => {
      const ac = new AbortController();
      return {
        signal: ac.signal,
        onCleanup: vi.fn(),
        listen: vi.fn(() => () => {}),
        timeout: (fn: () => void, ms: number) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        api: {
          viewer: vi.fn().mockResolvedValue(null),
          getMediaList: vi.fn(),
          ...overrides
        }
      } as any;
    };

    try {
      const stateMissing: any = { isLoadingAll: false, loadFailed: false, loadAbortState: null };
      await loadAllEntriesViaMediaList(makeMockCtx(), makeMockRc(), stateMissing, compareRoot, sidebar);
      expect(peekSpy).toHaveBeenCalledWith({ reconcile: true });
      expect(stateMissing.loadFailed).toBe(true);
      expect(debugLog).toHaveBeenCalledWith('Missing viewer or other user for getMediaList, keeping fallback');

      (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'MeUser' } } } };
      const boom = new Error('network boom');
      const getMediaList = vi.fn().mockRejectedValue(boom);
      const rcErr = makeMockRc({ getMediaList });
      const stateErr: any = { isLoadingAll: false, loadFailed: false, loadAbortState: null };
      await loadAllEntriesViaMediaList(
        makeMockCtx(),
        rcErr,
        stateErr,
        compareRoot,
        sidebar
      );
      expect(
        getMediaList.mock.calls.some(
          ([target, type, opts]) => target === 100 && type === 'ANIME' && opts?.signal === rcErr.signal
        )
      ).toBe(true);
      expect(stateErr.loadFailed).toBe(true);
      expect(errorLog).toHaveBeenCalledWith('CompareView getMediaList error:', boom);
    } finally {
      delete (window as any).__NUXT__;
      peekSpy.mockRestore();
      history.replaceState({}, '', '/');
      document.body.innerHTML = '';
    }
  });
});

describe('compareView: BUG-66..BUG-68 regressions', () => {
  const makeUiCtx = () =>
    ({
      session: AniList.session,
      hooks: {
        getCacheBridge: () => null,
        setPrefetchPaused: () => () => {}
      },
      log: {
        label: 'Compare View',
        title: 'Compare View Debug',
        canDebug: true,
        enabled: () => true,
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        channel: vi.fn()
      }
    }) as any;

  const makeUiRc = (overrides: Record<string, any> = {}) => {
    const ac = new AbortController();
    return {
      signal: ac.signal,
      onCleanup: vi.fn(),
      listen: vi.fn(() => () => {}),
      timeout: (fn: () => void, ms: number) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      api: {
        viewer: vi.fn().mockResolvedValue(null),
        getMediaList: vi.fn(),
        ...overrides
      }
    } as any;
  };

  const buildNativeCompareDom = (statusText = "OtherUser's Status") => {
    const container = document.createElement('div');
    container.className = 'content container';

    const compareRoot = document.createElement('div');
    compareRoot.className = 'compare';

    const header = document.createElement('div');
    header.className = 'entry header';

    const titleHeader = document.createElement('div');
    titleHeader.className = 'title';
    titleHeader.textContent = 'Title';

    const yourScoreHeader = document.createElement('div');
    yourScoreHeader.className = 'score';
    yourScoreHeader.textContent = 'Your Score';

    const otherScoreHeader = document.createElement('div');
    otherScoreHeader.className = 'score';
    otherScoreHeader.textContent = "OtherUser's Score";

    const yourStatusHeader = document.createElement('div');
    yourStatusHeader.className = 'status';
    yourStatusHeader.textContent = 'Your Status';

    const otherStatusHeader = document.createElement('div');
    otherStatusHeader.className = 'status';
    otherStatusHeader.textContent = statusText;

    header.append(titleHeader, yourScoreHeader, otherScoreHeader, yourStatusHeader, otherStatusHeader);

    const row1 = document.createElement('div');
    row1.className = 'entry';
    row1.innerHTML = `
      <div class="title"><a href="/anime/1">Alpha</a></div>
      <div class="score" label="Score" score="8"><span>8</span></div>
      <div class="score" score="9"><span>9</span></div>
      <div class="status" label="Your Status"><span>Completed</span></div>
      <div class="status"><span>Completed</span></div>
    `;

    const row2 = document.createElement('div');
    row2.className = 'entry';
    row2.innerHTML = `
      <div class="title"><a href="/anime/2">Beta</a></div>
      <div class="score" label="Score" score="7"><span>7</span></div>
      <div class="score" score="6"><span>6</span></div>
      <div class="status" label="Your Status"><span>Completed</span></div>
      <div class="status"><span>Completed</span></div>
    `;

    const scroller = document.createElement('div');
    scroller.className = 'scroller';

    compareRoot.append(header, row1, row2, scroller);
    container.appendChild(compareRoot);
    document.body.appendChild(container);

    return { container, compareRoot, header, titleHeader, yourScoreHeader, otherScoreHeader, otherStatusHeader, scroller };
  };

  it('BUG-66: detaches header click listeners in cleanupCompareView so re-entry does not stack handlers', () => {
    const { compareRoot, header, titleHeader, otherScoreHeader } = buildNativeCompareDom();
    const state = createCompareState();
    const rc = makeUiRc();

    try {
      setupCompareView(rc, state, compareRoot, header, Array.from(compareRoot.querySelectorAll('.entry:not(.header)')), () => {});
      cleanupCompareView(state);
      setupCompareView(rc, state, compareRoot, header, Array.from(compareRoot.querySelectorAll('.entry:not(.header)')), () => {});

      expect(state.activeSortCol).toBe('otherScore');
      expect(state.activeSortDir).toBe('desc');

      // Single click on active column must toggle desc -> asc once (not desc -> asc -> desc)
      otherScoreHeader.click();
      expect(state.activeSortCol).toBe('otherScore');
      expect(state.activeSortDir).toBe('asc');

      // Single click on title must set asc, then next click sets desc
      titleHeader.click();
      expect(state.activeSortCol).toBe('title');
      expect(state.activeSortDir).toBe('asc');
      titleHeader.click();
      expect(state.activeSortCol).toBe('title');
      expect(state.activeSortDir).toBe('desc');
    } finally {
      cleanupCompareView(state);
      document.body.innerHTML = '';
    }
  });

  it('BUG-67: preserves native .scroller when loadAllEntriesViaMediaList fails and removes it only on success', async () => {
    history.replaceState({}, '', '/user/OtherUser/animelist/compare');
    (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'MeUser' } } } };

    const stateFail = createCompareState();
    const { compareRoot, header, scroller } = buildNativeCompareDom();
    const ctx = makeUiCtx();
    const failingRc = makeUiRc({
      getMediaList: vi.fn().mockRejectedValue(new Error('network failure'))
    });

    try {
      let loadPromise: Promise<void> | undefined;
      setupCompareView(
        failingRc,
        stateFail,
        compareRoot,
        header,
        Array.from(compareRoot.querySelectorAll('.entry:not(.header)')),
        (root, sidebar) => {
          loadPromise = loadAllEntriesViaMediaList(ctx, failingRc, stateFail, root, sidebar);
        }
      );

      // Immediately after setupCompareView, .scroller must still exist before async load finishes
      expect(document.body.contains(scroller)).toBe(true);

      await loadPromise;
      expect(stateFail.loadFailed).toBe(true);
      expect(document.body.contains(scroller)).toBe(true);
      expect(compareRoot.style.display).not.toBe('none');

      cleanupCompareView(stateFail);
      document.body.innerHTML = '';

      // Now verify success path mounts #ala-compare-table and removes native .scroller
      const stateOk = createCompareState();
      const okDom = buildNativeCompareDom();
      const okRc = makeUiRc({
        getMediaList: vi.fn().mockResolvedValue({
          user: { id: 200, name: 'OtherUser' },
          allEntries: [{ mediaId: 1, score: 9, status: 'COMPLETED', media: { title: { userPreferred: 'Alpha' } } }]
        })
      });

      let okPromise: Promise<void> | undefined;
      setupCompareView(
        okRc,
        stateOk,
        okDom.compareRoot,
        okDom.header,
        Array.from(okDom.compareRoot.querySelectorAll('.entry:not(.header)')),
        (root, sidebar) => {
          okPromise = loadAllEntriesViaMediaList(ctx, okRc, stateOk, root, sidebar);
        }
      );

      await okPromise;
      expect(stateOk.isCompareLoaded).toBe(true);
      expect(document.body.contains(okDom.scroller)).toBe(false);
      expect(document.getElementById('ala-compare-table')).not.toBeNull();
      cleanupCompareView(stateOk);
    } finally {
      delete (window as any).__NUXT__;
      history.replaceState({}, '', '/');
      document.body.innerHTML = '';
    }
  });

  it('BUG-68: escapes HTML characters in status header text and resets isMutatingDOM on DOM errors', async () => {
    const xssText = '<img src=x onerror="alert(1)"> & "User"\'s Status';
    const { compareRoot, header, otherStatusHeader } = buildNativeCompareDom(xssText);
    const state = createCompareState();
    const ctx = makeUiCtx();
    const rc = makeUiRc();

    try {
      setupCompareView(rc, state, compareRoot, header, Array.from(compareRoot.querySelectorAll('.entry:not(.header)')), () => {});
      expect(otherStatusHeader.querySelector('img')).toBeNull();
      expect(otherStatusHeader.querySelector('.ala-header-label')?.textContent).toBe(xssText);

      // applySort resets state.isMutatingDOM in finally when DOM mutation throws
      const entries = Array.from(compareRoot.querySelectorAll<HTMLElement>('.entry:not(.header)'));
      const appendSpy = vi.spyOn(compareRoot, 'appendChild').mockImplementationOnce(() => {
        throw new Error('DOM append failure');
      });
      expect(() => applySort(state, compareRoot, entries, 'title', 'asc')).toThrow('DOM append failure');
      expect(state.isMutatingDOM).toBe(false);
      appendSpy.mockRestore();

      // mountCompareTable inside loadAllEntriesViaMediaList resets state.isMutatingDOM in finally on DOM error
      cleanupCompareView(state);
      document.body.innerHTML = '';

      history.replaceState({}, '', '/user/OtherUser/animelist/compare');
      (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'MeUser' } } } };
      const dom2 = buildNativeCompareDom();
      const state2 = createCompareState();
      const sidebar2 = document.createElement('div');
      document.body.appendChild(sidebar2);

      const okRc = makeUiRc({
        getMediaList: vi.fn().mockResolvedValue({
          user: { id: 200, name: 'OtherUser' },
          allEntries: [{ mediaId: 1, score: 9, status: 'COMPLETED', media: { title: { userPreferred: 'Alpha' } } }]
        })
      });

      const origAppendChild = HTMLElement.prototype.appendChild;
      const protoSpy = vi.spyOn(HTMLElement.prototype, 'appendChild').mockImplementation(function (this: HTMLElement, child: any) {
        if (this.id === 'ala-compare-table' && child instanceof DocumentFragment) {
          throw new Error('mountCompareTable DOM error');
        }
        return origAppendChild.call(this, child);
      });

      try {
        await loadAllEntriesViaMediaList(ctx, okRc, state2, dom2.compareRoot, sidebar2);
        expect(state2.isMutatingDOM).toBe(false);
        expect(state2.loadFailed).toBe(true);
      } finally {
        protoSpy.mockRestore();
        cleanupCompareView(state2);
      }
    } finally {
      delete (window as any).__NUXT__;
      history.replaceState({}, '', '/');
      cleanupCompareView(state);
      document.body.innerHTML = '';
    }
  });
});

describe('compareView: BUG-41 & BUG-42 route scoping and cleanup', () => {
  function createScopedRouteFixture(apiOverrides: Record<string, any> = {}) {
    const ac = new AbortController();
    const cleanups: Array<() => void> = [];
    const rc = {
      url: new URL(location.href),
      pathname: location.pathname,
      match: null,
      signal: ac.signal,
      onCleanup: (fn: () => void) => {
        cleanups.push(fn);
      },
      listen: (target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: any) => {
        target.addEventListener(type, listener, options);
        const off = () => target.removeEventListener(type, listener, options);
        cleanups.push(off);
        return off;
      },
      timeout: (fn: () => void, ms: number) => {
        const id = setTimeout(fn, ms);
        const off = () => clearTimeout(id);
        cleanups.push(off);
        return off;
      },
      api: {
        viewer: vi.fn().mockResolvedValue(null),
        getMediaList: vi.fn(),
        ...apiOverrides
      }
    } as any;

    const teardown = () => {
      ac.abort();
      for (const fn of [...cleanups].reverse()) {
        fn();
      }
      cleanups.length = 0;
    };

    return { rc, ac, teardown };
  }

  function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function buildDom() {
    const container = document.createElement('div');
    container.className = 'content container';

    const compareRoot = document.createElement('div');
    compareRoot.className = 'compare';

    const header = document.createElement('div');
    header.className = 'entry header';
    header.innerHTML = `
      <div class="title">Title</div>
      <div class="score">Your Score</div>
      <div class="score">Other Score</div>
      <div class="status">Your Status</div>
      <div class="status">Other Status</div>
    `;

    const scroller = document.createElement('div');
    scroller.className = 'scroller';

    compareRoot.append(header, scroller);
    container.appendChild(compareRoot);
    document.body.appendChild(container);
    return { container, compareRoot, header, scroller };
  }

  it('BUG-41: aborts User A load on User A -> User B transition and prevents stale catch/finally from clobbering User B', async () => {
    const errorLog = vi.fn();
    let prefetchPausedCount = 0;
    const ctx = {
      session: AniList.session,
      hooks: {
        getCacheBridge: () => null,
        setPrefetchPaused: vi.fn((paused: boolean) => {
          if (!paused) return () => {};
          let active = true;
          prefetchPausedCount++;
          return () => {
            if (!active) return;
            active = false;
            prefetchPausedCount--;
          };
        })
      },
      log: {
        label: 'Compare View',
        title: 'Compare View Debug',
        canDebug: true,
        enabled: () => true,
        debug: vi.fn(),
        warn: vi.fn(),
        error: errorLog,
        channel: vi.fn()
      }
    } as any;

    const state = createCompareState();
    const userAMyList = createDeferred<any>();
    const userAOtherList = createDeferred<any>();
    const userBMyList = createDeferred<any>();
    const userBOtherList = createDeferred<any>();

    const routeA = createScopedRouteFixture({
      getMediaList: vi.fn((target: number | string) =>
        target === 100 ? userAMyList.promise : userAOtherList.promise
      )
    });
    const routeB = createScopedRouteFixture({
      getMediaList: vi.fn((target: number | string) =>
        target === 100 ? userBMyList.promise : userBOtherList.promise
      )
    });

    try {
      (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'MeUser' } } } };

      // Start User A route
      history.replaceState({}, '', '/user/UserA/animelist/compare');
      const domA = buildDom();
      let loadAPromise: Promise<void> | undefined;
      setupCompareView(routeA.rc, state, domA.compareRoot, domA.header, [], (root, sidebar) => {
        loadAPromise = loadAllEntriesViaMediaList(ctx, routeA.rc, state, root, sidebar);
      });

      expect(state.isLoadingAll).toBe(true);
      expect(prefetchPausedCount).toBe(1);
      await Promise.resolve();
      expect(routeA.rc.api.getMediaList).toHaveBeenCalledWith(
        100,
        'ANIME',
        expect.objectContaining({ signal: routeA.ac.signal })
      );
      expect(routeA.rc.api.getMediaList).toHaveBeenCalledWith(
        'UserA',
        'ANIME',
        expect.objectContaining({ signal: routeA.ac.signal })
      );

      // Transition User A -> User B while User A's load is still pending
      routeA.teardown();
      cleanupCompareView(state);
      expect(routeA.ac.signal.aborted).toBe(true);
      expect(prefetchPausedCount).toBe(0);

      document.body.innerHTML = '';
      history.replaceState({}, '', '/user/UserB/animelist/compare');
      const domB = buildDom();
      let loadBPromise: Promise<void> | undefined;
      setupCompareView(routeB.rc, state, domB.compareRoot, domB.header, [], (root, sidebar) => {
        loadBPromise = loadAllEntriesViaMediaList(ctx, routeB.rc, state, root, sidebar);
      });
      await Promise.resolve();

      expect(state.isLoadingAll).toBe(true);
      expect(state.loadFailed).toBe(false);
      expect(prefetchPausedCount).toBe(1);
      const flightBAbortState = state.loadAbortState;
      expect(flightBAbortState).not.toBeNull();

      // Reject User A's pending calls (one AbortError, one stale late failure) while User B is active
      const abortErr = new DOMException('Request aborted', 'AbortError');
      userAMyList.reject(abortErr);
      userAOtherList.reject(new Error('late stale failure'));
      await loadAPromise;

      // User B's state, prefetch lock, and error log must remain untouched
      expect(state.isLoadingAll).toBe(true);
      expect(state.loadFailed).toBe(false);
      expect(state.loadAbortState).toBe(flightBAbortState);
      expect(prefetchPausedCount).toBe(1);
      expect(errorLog).not.toHaveBeenCalled();

      // Resolve User B's load
      userBMyList.resolve({
        user: { id: 100, name: 'MeUser' },
        allEntries: [{ mediaId: 42, score: 9, status: 'COMPLETED', media: { title: { userPreferred: 'User B Show' } } }]
      });
      userBOtherList.resolve({
        user: { id: 202, name: 'UserB' },
        allEntries: [{ mediaId: 42, score: 8, status: 'COMPLETED', media: { title: { userPreferred: 'User B Show' } } }]
      });
      await loadBPromise;

      expect(state.isCompareLoaded).toBe(true);
      expect(state.isLoadingAll).toBe(false);
      expect(state.loadFailed).toBe(false);
      expect(prefetchPausedCount).toBe(0);
      expect(document.querySelector('#ala-compare-table .title a')?.textContent).toBe('User B Show');
    } finally {
      routeA.teardown();
      routeB.teardown();
      cleanupCompareView(state);
      delete (window as any).__NUXT__;
      history.replaceState({}, '', '/');
      document.body.innerHTML = '';
    }
  });

  it('BUG-41: forwards rc.signal to rc.api.viewer in resolveCompareUsers and ignores AbortError on route abort', async () => {
    const errorLog = vi.fn();
    const peekSpy = vi.spyOn(AniList.session, 'peek').mockReturnValue({
      token: null,
      username: null,
      userId: null,
      scoreFormat: null,
      tokenAuth: null
    } as any);
    const ctx = {
      session: AniList.session,
      hooks: {
        getCacheBridge: () => null,
        setPrefetchPaused: () => () => {}
      },
      log: {
        label: 'Compare View',
        title: 'Compare View Debug',
        canDebug: true,
        enabled: () => true,
        debug: vi.fn(),
        warn: vi.fn(),
        error: errorLog,
        channel: vi.fn()
      }
    } as any;

    const viewerDeferred = createDeferred<any>();
    const route = createScopedRouteFixture({
      viewer: vi.fn().mockImplementation(() => viewerDeferred.promise)
    });
    const state = createCompareState();

    try {
      history.replaceState({}, '', '/user/OtherUser/animelist/compare');
      const compareRoot = document.createElement('div');
      compareRoot.className = 'compare';
      const sidebar = document.createElement('div');
      document.body.append(compareRoot, sidebar);

      const loadPromise = loadAllEntriesViaMediaList(ctx, route.rc, state, compareRoot, sidebar);
      expect(route.rc.api.viewer).toHaveBeenCalledWith(false, { signal: route.ac.signal });

      route.teardown();
      viewerDeferred.reject(new DOMException('Request aborted', 'AbortError'));
      await loadPromise;

      expect(state.loadFailed).toBe(false);
      expect(state.isLoadingAll).toBe(false);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      route.teardown();
      cleanupCompareView(state);
      peekSpy.mockRestore();
      history.replaceState({}, '', '/');
      document.body.innerHTML = '';
    }
  });

  it('BUG-42: deletes data-ala-compare-init in both wrap and unwrap-less cleanup branches and scopes resources to rc', async () => {
    const state = createCompareState();
    expect('resizeCleanup' in state).toBe(false);
    expect('indicatorTimer' in state).toBe(false);

    // 1. if (wrap) branch removes data-ala-compare-init and allows clean re-setup
    const dom1 = buildDom();
    const route1 = createScopedRouteFixture();
    try {
      setupCompareView(route1.rc, state, dom1.compareRoot, dom1.header, [], () => {});
      expect(document.getElementById('ala-compare-wrap')).not.toBeNull();
      expect(dom1.compareRoot.dataset.alaCompareInit).toBe('true');

      cleanupCompareView(state);
      expect(document.getElementById('ala-compare-wrap')).toBeNull();
      expect(dom1.container.contains(dom1.compareRoot)).toBe(true);
      expect(dom1.compareRoot.dataset.alaCompareInit).toBeUndefined();
      expect('alaCompareInit' in dom1.compareRoot.dataset).toBe(false);

      // Re-init on the same unwrapped .compare node succeeds without stale dataset marker
      setupCompareView(route1.rc, state, dom1.compareRoot, dom1.header, [], () => {});
      expect(document.getElementById('ala-compare-wrap')).not.toBeNull();
      expect(dom1.compareRoot.dataset.alaCompareInit).toBe('true');
    } finally {
      route1.teardown();
      cleanupCompareView(state);
      document.body.innerHTML = '';
    }

    // 2. else branch (no #ala-compare-wrap) deletes data-ala-compare-init and restores display
    const dom2 = buildDom();
    dom2.compareRoot.dataset.alaCompareInit = 'true';
    dom2.compareRoot.style.display = 'none';
    cleanupCompareView(state);
    expect(dom2.compareRoot.dataset.alaCompareInit).toBeUndefined();
    expect(dom2.compareRoot.style.display).toBe('');
    document.body.innerHTML = '';

    // 3. rc-scoped teardown: resize listener via rc.listen, indicatorTimer via rc.timeout, prefetch via rc.onCleanup
    vi.useFakeTimers();
    const originalInnerWidth = window.innerWidth;
    let prefetchPaused = false;
    const ctx = {
      session: AniList.session,
      hooks: {
        getCacheBridge: () => null,
        setPrefetchPaused: vi.fn((paused: boolean) => {
          if (!paused) return () => {};
          prefetchPaused = true;
          return () => {
            prefetchPaused = false;
          };
        })
      },
      log: {
        label: 'Compare View',
        title: 'Compare View Debug',
        canDebug: true,
        enabled: () => true,
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        channel: vi.fn()
      }
    } as any;

    const pendingList = createDeferred<any>();
    const dom3 = buildDom();
    const route3 = createScopedRouteFixture({
      getMediaList: vi.fn().mockImplementation(() => pendingList.promise)
    });
    const listenSpy = vi.spyOn(route3.rc, 'listen');
    const timeoutSpy = vi.spyOn(route3.rc, 'timeout');
    const onCleanupSpy = vi.spyOn(route3.rc, 'onCleanup');

    try {
      (window as any).__NUXT__ = { state: { auth: { user: { id: 100, name: 'MeUser' } } } };
      history.replaceState({}, '', '/user/OtherUser/animelist/compare');
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });

      let loadPromise: Promise<void> | undefined;
      setupCompareView(route3.rc, state, dom3.compareRoot, dom3.header, [], (root, sidebar) => {
        loadPromise = loadAllEntriesViaMediaList(ctx, route3.rc, state, root, sidebar);
      });
      await Promise.resolve();

      expect(listenSpy).toHaveBeenCalledWith(window, 'resize', expect.any(Function));
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 250);
      expect(onCleanupSpy).toHaveBeenCalledWith(expect.any(Function));
      expect(prefetchPaused).toBe(true);
      expect(route3.rc.api.getMediaList).toHaveBeenCalled();

      const details = document.querySelector<HTMLDetailsElement>('.ala-compare-card')!;
      expect(details.open).toBe(true);

      // Tearing down rc removes resize listener, cancels 250ms indicator timer, and releases prefetch pause
      route3.teardown();
      expect(prefetchPaused).toBe(false);

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
      window.dispatchEvent(new Event('resize'));
      expect(details.open).toBe(true);

      await vi.advanceTimersByTimeAsync(300);
      expect(document.getElementById('ala-compare-load-indicator')).toBeNull();

      pendingList.reject(new DOMException('Request aborted', 'AbortError'));
      await loadPromise;
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      vi.useRealTimers();
      route3.teardown();
      cleanupCompareView(state);
      delete (window as any).__NUXT__;
      history.replaceState({}, '', '/');
      document.body.innerHTML = '';
    }
  });
});
