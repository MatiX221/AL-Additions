import { describe, it, expect, vi } from 'vitest';
import { strictTitle } from '../src/api/mal';
import {
  normTitle,
  titleScore,
  bestMatch,
  parseLatest,
  mangaUpdates,
  novelUpdates,
  externalReleased,
  muLimiter,
  nuLimiter,
  type ScraperHttpClient
} from '../src/api/scrapers';

describe('Matching: normTitle', () => {
  it('handles null, undefined, and empty string inputs', () => {
    expect(normTitle(null)).toBe('');
    expect(normTitle(undefined)).toBe('');
    expect(normTitle('')).toBe('');
    expect(normTitle('   ')).toBe('');
  });

  it('normalizes punctuation, semicolons, slashes, dashes, and casing', () => {
    expect(normTitle('Steins;Gate 0')).toBe('steins gate 0');
    expect(normTitle('Fate/stay night [Unlimited Blade Works]!')).toBe('fate stay night unlimited blade works');
    expect(normTitle('“Kaguya-sama”, (Love is War)...')).toBe('kaguya sama love is war');
    expect(normTitle('Re:Zero kara Hajimeru Isekai Seikatsu')).toBe('re zero kara hajimeru isekai seikatsu');
    expect(normTitle('Hello_World?')).toBe('hello world');
  });

  it('strips English standalone articles (the, a, an)', () => {
    expect(normTitle('The Melancholy of Haruhi Suzumiya')).toBe('melancholy of haruhi suzumiya');
    expect(normTitle('A Silent Voice')).toBe('silent voice');
    expect(normTitle('An Another Story')).toBe('another story');
    expect(normTitle('Another')).toBe('another');
    expect(normTitle('Theater')).toBe('theater');
  });

  it('normalizes internal and surrounding whitespace', () => {
    expect(normTitle('   Attack    on    Titan   ')).toBe('attack on titan');
  });
});

describe('Matching: strictTitle', () => {
  it('handles null, undefined, and empty string inputs', () => {
    expect(strictTitle(null)).toBe('');
    expect(strictTitle(undefined)).toBe('');
    expect(strictTitle('')).toBe('');
  });

  it('strips quotes without inserting spaces', () => {
    expect(strictTitle("JoJo's Bizarre Adventure")).toBe('jojos bizarre adventure');
    expect(strictTitle('Shingeki no Kyojin ‘Final’')).toBe('shingeki no kyojin final');
  });

  it('preserves unicode letters and numbers with NFKC normalization', () => {
    expect(strictTitle('ＳＰＹ×ＦＡＭＩＬＹ')).toBe('spy family');
    expect(strictTitle('Mob Psycho 100 Ⅱ')).toBe('mob psycho 100 ii');
    expect(strictTitle('進撃の巨人')).toBe('進撃の巨人');
    expect(strictTitle('Sousou no Frieren: 2nd Season')).toBe('sousou no frieren 2nd season');
  });

  it('strips symbols, slashes, and semicolons to single spaces', () => {
    expect(strictTitle('Steins;Gate 0')).toBe('steins gate 0');
    expect(strictTitle('Fate/stay night [Unlimited Blade Works]')).toBe('fate stay night unlimited blade works');
    expect(strictTitle('Code Geass: Lelouch of the Rebellion R2 (TV)')).toBe(
      'code geass lelouch of the rebellion r2 tv'
    );
  });
});

describe('Matching: titleScore', () => {
  it('returns 0 when either or both titles are empty or missing', () => {
    expect(titleScore(null, 'Frieren')).toBe(0);
    expect(titleScore('Frieren', undefined)).toBe(0);
    expect(titleScore('', '')).toBe(0);
  });

  it('returns 100 for exact matches under normTitle', () => {
    expect(titleScore('Bocchi the Rock!', 'bocchi the rock')).toBe(100);
    expect(titleScore('Steins;Gate', 'Steins Gate')).toBe(100);
    expect(titleScore('The Dangers in My Heart', 'Dangers in My Heart')).toBe(100);
  });

  it('scores whole-word substring containment proportionally', () => {
    const scoreA = titleScore('Frieren', "Frieren: Beyond Journey's End");
    expect(scoreA).toBeGreaterThanOrEqual(60);
    expect(scoreA).toBeLessThanOrEqual(95);

    const scoreB = titleScore('Chainsaw Man', 'Chainsaw Man Part 2');
    expect(scoreB).toBeGreaterThan(scoreA);
  });

  it('scores word set token overlaps using Jaccard index', () => {
    const score = titleScore('My Hero Academia Movie', 'Boku no Hero Academia');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('returns 0 for completely unrelated titles', () => {
    expect(titleScore('Death Note', 'Bleach')).toBe(0);
    expect(titleScore('Naruto', 'One Piece')).toBe(0);
  });
});

describe('Matching: bestMatch', () => {
  interface AnimeEntry {
    id: number;
    title: string;
  }

  const catalog: AnimeEntry[] = [
    { id: 1, title: 'Bocchi the Rock!' },
    { id: 2, title: 'K-On!' },
    { id: 3, title: 'Chainsaw Man' },
    { id: 4, title: 'Chainsaw Man: Reze Arc' }
  ];

  it('returns the best matching item above threshold', () => {
    const match = bestMatch(catalog, 'bocchi the rock', (item) => item.title);
    expect(match).not.toBeNull();
    expect(match?.id).toBe(1);
  });

  it('correctly prefers specific sequel/arc titles over the generic parent show', () => {
    const match = bestMatch(catalog, 'Chainsaw Man: Reze', (item) => item.title, 50);
    expect(match?.id).toBe(4);
  });

  it('returns null if no item achieves the minimum required score', () => {
    const match = bestMatch(catalog, 'Attack on Titan', (item) => item.title, 70);
    expect(match).toBeNull();
  });

  it('returns null when querying an empty array', () => {
    const match = bestMatch([], 'Any Title', (item: AnimeEntry) => item.title);
    expect(match).toBeNull();
  });
});

describe('Scrapers: parseLatest', () => {
  it('parses thousands-separator numbers without truncating leading digits', () => {
    expect(parseLatest('1,234')).toBe(1234);
    expect(parseLatest('1,234 Chapters')).toBe(1234);
    expect(parseLatest('1,234,567')).toBe(1234567);
    expect(parseLatest('v2 c1,234.5')).toBe(1234.5);
  });

  it('preserves comma-separated chapter lists', () => {
    expect(parseLatest('c10, c12')).toBe(12);
    expect(parseLatest('10, 12')).toBe(12);
  });

  it('returns null for empty and unknown placeholders', () => {
    expect(parseLatest(null)).toBeNull();
    expect(parseLatest('')).toBeNull();
    expect(parseLatest('N/A')).toBeNull();
    expect(parseLatest('unknown')).toBeNull();
  });
});

describe('Scrapers: novelUpdates', () => {
  it('skips malformed hrefs and non-http(s) URLs while scoring valid series anchors', async () => {
    const requestedUrls: string[] = [];
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      requestedUrls.push(opts.url);
      if (opts.url.includes('?s=')) {
        opts.onload({
          status: 200,
          responseText: `
            <html><body>
              <a href="https://[invalid/series/broken">Broken Series</a>
              <a href="javascript:void('/series/js-trap')">My Target Novel</a>
              <a href="data:text/html,/series/data-trap">My Target Novel</a>
              <a href="/series/my-target-novel/">My Target Novel</a>
            </body></html>
          `
        });
      } else {
        opts.onload({
          status: 200,
          responseText: '<html><body>Latest Release c42</body></html>'
        });
      }
    });

    const latest = await novelUpdates('My Target Novel');
    expect(latest).toBe(42);
    expect(requestedUrls).toEqual([
      'https://www.novelupdates.com/?s=My%20Target%20Novel&post_type=series',
      'https://www.novelupdates.com/series/my-target-novel/'
    ]);
  });
});

describe('Scrapers: externalReleased', () => {
  it('uses cleaned lowercase fallback key for article-only titles so they do not collide', async () => {
    const searchedTitles: string[] = [];
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
      const body = opts.data ? JSON.parse(opts.data) : null;
      if (body?.search) {
        searchedTitles.push(body.search);
        const chapter = body.search === 'The' ? '15' : '99';
        opts.onload({
          status: 200,
          responseText: JSON.stringify({
            results: [{ hit_title: body.search, record: { title: body.search, latest_chapter: chapter } }]
          })
        });
        return;
      }
      opts.onload({ status: 404, responseText: '' });
    });

    // "The" and "A" both normalize to "" under normTitle, so each must still cache separately.
    // Note: titleScore("The", "The") is 0 because normTitle strips articles, so mock hit_title won't match bestMatch;
    // what matters for BUG-33 is that both trigger separate lookup calls instead of colliding on "MU:".
    await externalReleased({ format: 'MANGA', title: { romaji: 'The' } });
    await externalReleased({ format: 'MANGA', title: { romaji: 'A' } });

    expect(searchedTitles).toEqual(['The', 'A']);
  });

  it('skips completely blank titles without querying external services', async () => {
    const spy = vi.mocked(globalThis.GM_xmlhttpRequest);
    const res = await externalReleased({ format: 'MANGA', title: { userPreferred: '   ', romaji: '\t\n' } });
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('IMP-12: accepts custom http client and acquires from muLimiter / nuLimiter', async () => {
    muLimiter.tokens = muLimiter.burst;
    muLimiter.last = Date.now();
    nuLimiter.tokens = nuLimiter.burst;
    nuLimiter.last = Date.now();
    const muAcquireSpy = vi.spyOn(muLimiter, 'acquire');
    const nuAcquireSpy = vi.spyOn(nuLimiter, 'acquire');
    const customHttp: ScraperHttpClient = {
      json: vi.fn().mockResolvedValue({
        results: [{ hit_title: 'IMP12 Custom MU', record: { title: 'IMP12 Custom MU', latest_chapter: '47' } }]
      }),
      text: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('?s=')) {
          return '<a href="/series/imp12-nu/">IMP12 Custom NU</a>';
        }
        return '<html><body>Latest Release c88</body></html>';
      })
    };

    try {
      const muRes = await mangaUpdates('IMP12 Custom MU', { http: customHttp });
      expect(muRes).toBe(47);
      expect(muAcquireSpy).toHaveBeenCalledTimes(1);
      expect(customHttp.json).toHaveBeenCalledTimes(1);

      const nuRes = await novelUpdates('IMP12 Custom NU', { http: customHttp });
      expect(nuRes).toBe(88);
      expect(nuAcquireSpy).toHaveBeenCalledTimes(2);
      expect(customHttp.text).toHaveBeenCalledTimes(2);
    } finally {
      muAcquireSpy.mockRestore();
      nuAcquireSpy.mockRestore();
    }
  });

  it('IMP-12: enforces muLimiter rate limiting when burst tokens are exhausted and aborts queued acquire via signal', async () => {
    vi.useFakeTimers();
    muLimiter.tokens = 0;
    muLimiter.last = Date.now();

    const customHttp: ScraperHttpClient = {
      json: vi.fn().mockResolvedValue({
        results: [{ hit_title: 'Rate Limited Title', record: { title: 'Rate Limited Title', latest_chapter: '12' } }]
      }),
      text: vi.fn()
    };

    try {
      const ac = new AbortController();
      const abortedReq = mangaUpdates('Rate Limited Title', { http: customHttp, signal: ac.signal });
      ac.abort();
      await expect(abortedReq).rejects.toMatchObject({ name: 'AbortError' });
      expect(customHttp.json).not.toHaveBeenCalled();

      // With 0 tokens and rate=30/min (1 token every 2000ms), request waits until token refills
      const delayedReq = mangaUpdates('Rate Limited Title', { http: customHttp });
      await Promise.resolve();
      expect(customHttp.json).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2100);
      await expect(delayedReq).resolves.toBe(12);
      expect(customHttp.json).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      muLimiter.tokens = muLimiter.burst;
      muLimiter.last = Date.now();
    }
  });

  it('IMP-12: isolates per-caller AbortSignal aborts in externalReleased without poisoning cache or aborting live callers', async () => {
    muLimiter.tokens = muLimiter.burst;
    muLimiter.last = Date.now();
    let resolveFirst!: (val: any) => void;
    const firstPending = new Promise<any>((res) => {
      resolveFirst = res;
    });
    const customHttp: ScraperHttpClient = {
      json: vi
        .fn()
        .mockReturnValueOnce(firstPending)
        .mockResolvedValue({
          results: [{ hit_title: 'IMP12 All Abort', record: { title: 'IMP12 All Abort', latest_chapter: '101' } }]
        }),
      text: vi.fn()
    };

    const flushMicrotasks = async (rounds = 8) => {
      for (let i = 0; i < rounds; i++) await Promise.resolve();
    };

    // 1. Pre-aborted signal rejects immediately without calling http
    const preAc = new AbortController();
    preAc.abort();
    await expect(
      externalReleased({ format: 'MANGA', title: { romaji: 'IMP12 Isolated Manga' } }, { http: customHttp, signal: preAc.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(customHttp.json).not.toHaveBeenCalled();

    // 2. Two concurrent callers: aborting caller 1 rejects caller 1 with AbortError while caller 2 & cache succeed
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = externalReleased(
      { format: 'MANGA', title: { romaji: 'IMP12 Isolated Manga', english: 'IMP12 Fallback Title' } },
      { http: customHttp, signal: ac1.signal }
    );
    const p2 = externalReleased(
      { format: 'MANGA', title: { romaji: 'IMP12 Isolated Manga' } },
      { http: customHttp, signal: ac2.signal }
    );

    await flushMicrotasks();
    expect(customHttp.json).toHaveBeenCalledTimes(1);

    ac1.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });

    resolveFirst({
      results: [{ hit_title: 'IMP12 Isolated Manga', record: { title: 'IMP12 Isolated Manga', latest_chapter: '77' } }]
    });
    await expect(p2).resolves.toBe(77);

    // Subsequent caller hits the cached 77 result without a new HTTP call (and pre-aborted doesn't poison cache)
    await expect(
      externalReleased({ format: 'MANGA', title: { romaji: 'IMP12 Isolated Manga' } }, { http: customHttp, signal: preAc.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      externalReleased({ format: 'MANGA', title: { romaji: 'IMP12 Isolated Manga' } }, { http: customHttp })
    ).resolves.toBe(77);
    expect(customHttp.json).toHaveBeenCalledTimes(1);

    // 3. When the sole caller aborts mid-flight, cache is not poisoned and a retry triggers a fresh request
    let resolveSole!: (val: any) => void;
    const solePending = new Promise<any>((res) => {
      resolveSole = res;
    });
    vi.mocked(customHttp.json).mockReturnValueOnce(solePending);
    const soleAc = new AbortController();
    const soleCall = externalReleased(
      { format: 'MANGA', title: { romaji: 'IMP12 All Abort' } },
      { http: customHttp, signal: soleAc.signal }
    );
    await flushMicrotasks();
    expect(customHttp.json).toHaveBeenCalledTimes(2);
    soleAc.abort();
    await expect(soleCall).rejects.toMatchObject({ name: 'AbortError' });
    resolveSole({ results: [] });

    await expect(
      externalReleased({ format: 'MANGA', title: { romaji: 'IMP12 All Abort' } }, { http: customHttp })
    ).resolves.toBe(101);
    expect(customHttp.json).toHaveBeenCalledTimes(3);
  });

  it('BUG-17: isolates concurrent flights with distinct http transports while preserving shared customHttp coalescing', async () => {
    muLimiter.tokens = muLimiter.burst;
    muLimiter.last = Date.now();

    let rejectHttp1!: (err: Error) => void;
    const http1: ScraperHttpClient = {
      json: vi.fn().mockImplementation(
        () =>
          new Promise((_, rej) => {
            rejectHttp1 = rej;
          })
      ),
      text: vi.fn()
    };

    let resolveHttp2!: (val: any) => void;
    const http2: ScraperHttpClient = {
      json: vi.fn().mockImplementation(
        () =>
          new Promise((res) => {
            resolveHttp2 = res;
          })
      ),
      text: vi.fn()
    };

    const sharedHttp: ScraperHttpClient = {
      json: vi.fn().mockResolvedValue({
        results: [{ hit_title: 'BUG17 Shared Transport', record: { title: 'BUG17 Shared Transport', latest_chapter: '55' } }]
      }),
      text: vi.fn()
    };

    const p1 = externalReleased({ format: 'MANGA', title: { romaji: 'BUG17 Distinct Transport' } }, { http: http1 });
    const p2 = externalReleased({ format: 'MANGA', title: { romaji: 'BUG17 Distinct Transport' } }, { http: http2 });

    await vi.waitFor(() => {
      expect(http1.json).toHaveBeenCalledTimes(1);
      expect(http2.json).toHaveBeenCalledTimes(1);
    });

    // Simulate Caller 1's route-bound http1 aborting with HttpClient's Error('Request aborted').
    rejectHttp1(new Error('Request aborted'));
    await expect(p1).rejects.toThrow('Request aborted');

    // Caller 2 on distinct http2 is completely isolated and resolves normally.
    resolveHttp2({
      results: [{ hit_title: 'BUG17 Distinct Transport', record: { title: 'BUG17 Distinct Transport', latest_chapter: '89' } }]
    });
    await expect(p2).resolves.toBe(89);

    // Concurrent callers sharing the same customHttp still coalesce into one request.
    const s1 = externalReleased({ format: 'MANGA', title: { romaji: 'BUG17 Shared Transport' } }, { http: sharedHttp });
    const s2 = externalReleased({ format: 'MANGA', title: { romaji: 'BUG17 Shared Transport' } }, { http: sharedHttp });
    await expect(Promise.all([s1, s2])).resolves.toEqual([55, 55]);
    expect(sharedHttp.json).toHaveBeenCalledTimes(1);
  });

  it('BUG-17: propagates Error("Request aborted") out of tryScraperOrAbort and externalReleased without caching null', async () => {
    muLimiter.tokens = muLimiter.burst;
    muLimiter.last = Date.now();

    const customHttp: ScraperHttpClient = {
      json: vi
        .fn()
        // 1st attempt: search finds record with series_id but no latest_chapter -> enters tryScraperOrAbort detail fetch
        .mockResolvedValueOnce({
          results: [{ hit_title: 'BUG17 Abort Propagate', record: { title: 'BUG17 Abort Propagate', series_id: 777 } }]
        })
        // Detail fetch inside tryScraperOrAbort rejects with HttpClient's Error('Request aborted')
        .mockRejectedValueOnce(new Error('Request aborted'))
        // 2nd attempt (retry after abort): search + detail succeed
        .mockResolvedValueOnce({
          results: [{ hit_title: 'BUG17 Abort Propagate', record: { title: 'BUG17 Abort Propagate', series_id: 777 } }]
        })
        .mockResolvedValueOnce({ latest_chapter: '144' }),
      text: vi.fn()
    };

    // Must reject with Error('Request aborted') rather than swallowing it in tryScraperOrAbort or trying fallback title.
    await expect(
      externalReleased(
        { format: 'MANGA', title: { romaji: 'BUG17 Abort Propagate', english: 'BUG17 Fallback Unused' } },
        { http: customHttp }
      )
    ).rejects.toThrow('Request aborted');
    expect(customHttp.json).toHaveBeenCalledTimes(2);

    // Must not have cached null from the aborted lookup; retrying succeeds.
    await expect(
      externalReleased({ format: 'MANGA', title: { romaji: 'BUG17 Abort Propagate' } }, { http: customHttp })
    ).resolves.toBe(144);
    expect(customHttp.json).toHaveBeenCalledTimes(4);
  });
});