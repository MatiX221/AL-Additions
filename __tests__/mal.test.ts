import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAL_API,
  MAL_TOKEN_URL,
  breaker,
  hooks,
  log,
  logLines,
  lastNotice,
  malCall,
  malConnect,
  malDeleteEntry,
  malEnsureToken,
  malFetchList,
  malLimiter,
  malRequest,
  malUpdateEntry,
  malWhoAmI,
  parseRetryAfterMs,
  searchCandidates,
  searchMalId,
  setMalUiSink,
  toast
} from '../src/api/mal';
import { SETTING_PREFIX } from '../src/types';
import { store } from '../src/utils/helpers';

type GmRequestOpts = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: any;
  onload?: (res: any) => void;
  onerror?: () => void;
};

describe('MAL API: Token Refresh Race & Validation (B1-16)', () => {
  beforeEach(() => {
    store.del('mal_token');
    store.del('mal_refresh_token');
    store.del('mal_expires_at');
    store.del('mal_code_verifier');
    store.del('ala_mal_api_resume_at');
    malLimiter.until = 0;
    malLimiter.setRate(60);
    malLimiter.tokens = malLimiter.burst;
    malLimiter.okStreak = 0;
    breaker.reset();
    setMalUiSink(null);
    vi.mocked(globalThis.GM_xmlhttpRequest).mockReset();
  });

  afterEach(() => {
    setMalUiSink(null);
    vi.restoreAllMocks();
  });

  it('coalesces concurrent 401s on T1 into a single refresh to T2 without clearing auth', async () => {
    store.set('mal_token', 'T1');
    store.set('mal_refresh_token', 'R1');
    store.set('mal_expires_at', Date.now() + 3600_000);

    const apiPending: Array<{ auth?: string; resolve: (res: any) => void }> = [];
    const tokenPending: Array<{ data?: string; resolve: (res: any) => void }> = [];

    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      if (opts.url === MAL_TOKEN_URL) {
        tokenPending.push({
          data: opts.data,
          resolve: (res) => opts.onload?.(res)
        });
        return;
      }
      apiPending.push({
        auth: opts.headers?.Authorization,
        resolve: (res) => opts.onload?.(res)
      });
    });

    const p1 = malCall({ url: `${MAL_API}/users/@me` });
    const p2 = malCall({ url: `${MAL_API}/anime/1` });

    await vi.waitFor(() => {
      expect(apiPending).toHaveLength(2);
    });
    expect(apiPending[0].auth).toBe('Bearer T1');
    expect(apiPending[1].auth).toBe('Bearer T1');

    apiPending[0].resolve({ status: 401, responseText: 'Unauthorized', responseHeaders: '' });
    apiPending[1].resolve({ status: 401, responseText: 'Unauthorized', responseHeaders: '' });

    await vi.waitFor(() => {
      expect(tokenPending).toHaveLength(1);
    });
    expect(tokenPending[0].data).toContain('refresh_token=R1');

    tokenPending[0].resolve({
      status: 200,
      responseText: JSON.stringify({ access_token: 'T2', refresh_token: 'R2', expires_in: 3600 })
    });

    await vi.waitFor(() => {
      expect(apiPending).toHaveLength(4);
    });
    expect(apiPending[2].auth).toBe('Bearer T2');
    expect(apiPending[3].auth).toBe('Bearer T2');

    apiPending[2].resolve({ status: 200, responseText: '{"id":1}', responseHeaders: '' });
    apiPending[3].resolve({ status: 200, responseText: '{"id":2}', responseHeaders: '' });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(tokenPending).toHaveLength(1);
    expect(store.get('mal_token')).toBe('T2');
    expect(store.get('mal_refresh_token')).toBe('R2');
    expect(store.get('mal_expires_at')).toBeGreaterThan(Date.now());
  });

  it('does not wipe T2 or re-refresh when a late in-flight T1 request gets 401 after refresh finished', async () => {
    store.set('mal_token', 'T1');
    store.set('mal_refresh_token', 'R1');
    const initialExp = Date.now() + 3600_000;
    store.set('mal_expires_at', initialExp);

    const apiPending: Array<{ auth?: string; resolve: (res: any) => void }> = [];
    let tokenRefreshCalls = 0;

    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      if (opts.url === MAL_TOKEN_URL) {
        tokenRefreshCalls++;
        opts.onload?.({
          status: 200,
          responseText: JSON.stringify({ access_token: 'T2', refresh_token: 'R2', expires_in: 3600 })
        });
        return;
      }
      apiPending.push({
        auth: opts.headers?.Authorization,
        resolve: (res) => opts.onload?.(res)
      });
    });

    const p1 = malCall({ url: `${MAL_API}/users/@me` });
    const p2 = malCall({ url: `${MAL_API}/anime/2` });

    await vi.waitFor(() => {
      expect(apiPending).toHaveLength(2);
    });

    apiPending[0].resolve({ status: 401, responseText: 'Unauthorized', responseHeaders: '' });
    await vi.waitFor(() => {
      expect(apiPending).toHaveLength(3);
    });
    expect(apiPending[2].auth).toBe('Bearer T2');
    apiPending[2].resolve({ status: 200, responseText: '{"ok":1}', responseHeaders: '' });
    await expect(p1).resolves.toMatchObject({ status: 200 });

    const expAfterRefresh = store.get<number>('mal_expires_at', 0);
    expect(expAfterRefresh).toBeGreaterThan(Date.now());
    expect(tokenRefreshCalls).toBe(1);

    apiPending[1].resolve({ status: 401, responseText: 'Unauthorized', responseHeaders: '' });

    await vi.waitFor(() => {
      expect(apiPending).toHaveLength(4);
    });
    expect(apiPending[3].auth).toBe('Bearer T2');
    apiPending[3].resolve({ status: 200, responseText: '{"ok":2}', responseHeaders: '' });

    await expect(p2).resolves.toMatchObject({ status: 200 });
    expect(tokenRefreshCalls).toBe(1);
    expect(store.get('mal_token')).toBe('T2');
    expect(store.get('mal_expires_at')).toBe(expAfterRefresh);
  });

  it('clears MAL auth and throws authError if 401 persists after refreshing to a new token', async () => {
    store.set('mal_token', 'T1');
    store.set('mal_refresh_token', 'R1');
    store.set('mal_expires_at', Date.now() + 3600_000);

    const seenAuthHeaders: string[] = [];
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      if (opts.url === MAL_TOKEN_URL) {
        opts.onload?.({
          status: 200,
          responseText: JSON.stringify({ access_token: 'T2', refresh_token: 'R2', expires_in: 3600 })
        });
        return;
      }
      seenAuthHeaders.push(opts.headers?.Authorization || '');
      opts.onload?.({ status: 401, responseText: 'Unauthorized', responseHeaders: '' });
    });

    await expect(malCall({ url: `${MAL_API}/users/@me` })).rejects.toMatchObject({
      auth: 'MAL'
    });
    expect(seenAuthHeaders).toEqual(['Bearer T1', 'Bearer T2']);
    expect(store.get('mal_token', null)).toBeNull();
    expect(store.get('mal_refresh_token', null)).toBeNull();
    expect(store.get('mal_expires_at', null)).toBeNull();
  });

  it('does not reuse failed token T1 if token refresh hits a transient network error before succeeding', async () => {
    vi.useFakeTimers();
    try {
      store.set('mal_token', 'T1');
      store.set('mal_refresh_token', 'R1');
      store.set('mal_expires_at', Date.now() + 3600_000);

      let tokenAttempts = 0;
      const seenAuthHeaders: string[] = [];

      vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
        if (opts.url === MAL_TOKEN_URL) {
          tokenAttempts++;
          if (tokenAttempts === 1) {
            opts.onerror?.();
            return;
          }
          opts.onload?.({
            status: 200,
            responseText: JSON.stringify({ access_token: 'T2', refresh_token: 'R2', expires_in: 3600 })
          });
          return;
        }
        const auth = opts.headers?.Authorization || '';
        seenAuthHeaders.push(auth);
        if (auth === 'Bearer T1') {
          opts.onload?.({ status: 401, responseText: 'Unauthorized', responseHeaders: '' });
        } else {
          opts.onload?.({ status: 200, responseText: '{"ok":true}', responseHeaders: '' });
        }
      });

      const callPromise = malCall({ url: `${MAL_API}/users/@me` });
      await vi.runAllTimersAsync();
      const res = await callPromise;

      expect(res.status).toBe(200);
      expect(tokenAttempts).toBe(2);
      expect(seenAuthHeaders).toEqual(['Bearer T1', 'Bearer T2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes or throws authError when mal_token is missing/empty or mal_expires_at is non-finite', async () => {
    store.set('mal_token', '');
    store.set('mal_refresh_token', 'R1');
    store.set('mal_expires_at', Date.now() + 3600_000);

    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      expect(opts.url).toBe(MAL_TOKEN_URL);
      opts.onload?.({
        status: 200,
        responseText: JSON.stringify({ access_token: 'T_FRESH', refresh_token: 'R2', expires_in: 3600 })
      });
    });

    await expect(malEnsureToken()).resolves.toBe('T_FRESH');
    expect(store.get('mal_token')).toBe('T_FRESH');

    store.set('mal_token', '');
    store.del('mal_refresh_token');
    store.set('mal_expires_at', Date.now() + 3600_000);
    await expect(malEnsureToken()).rejects.toMatchObject({ auth: 'MAL' });

    store.set('mal_token', 'T_OLD');
    store.set('mal_refresh_token', 'R2');
    store.set('mal_expires_at', Infinity);
    await expect(malEnsureToken()).resolves.toBe('T_FRESH');
  });

  it('preserves exported malRequest return value as raw response', async () => {
    store.set('mal_token', 'T1');
    store.set('mal_expires_at', Date.now() + 3600_000);

    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      expect(opts.headers?.Authorization).toBe('Bearer T1');
      opts.onload?.({ status: 200, responseText: '{"name":"tester"}', responseHeaders: '' });
    });

    const res = await malRequest({ url: `${MAL_API}/users/@me` });
    expect(res.status).toBe(200);
    expect(res.responseText).toBe('{"name":"tester"}');
  });
});

describe('MAL API: uiSink Fault Isolation (B1-17)', () => {
  beforeEach(() => {
    breaker.reset();
    setMalUiSink(null);
    store.del('mal_code_verifier');
    document.body.innerHTML = '';
  });

  afterEach(() => {
    setMalUiSink(null);
    vi.restoreAllMocks();
  });

  it('isolates throwing uiSink.onLog so log(), breaker.fail(), and malConnect() still complete', () => {
    setMalUiSink({
      onLog: () => {
        throw new Error('sink log boom');
      }
    });

    expect(() => log('hello sync', 'info')).not.toThrow();
    expect(lastNotice).toBe('hello sync');
    expect(logLines[0]).toContain('hello sync');

    for (let i = 0; i < 8; i++) {
      expect(() => breaker.fail()).not.toThrow();
    }
    expect(breaker.trips).toBe(1);

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    expect(() => malConnect()).not.toThrow();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(typeof store.get('mal_code_verifier', '')).toBe('string');
    expect(store.get<string>('mal_code_verifier', '').length).toBe(96);
  });

  it('falls back to showToast() rendering #ala-toast when uiSink.onToast throws', () => {
    setMalUiSink({
      onLog: () => {
        throw new Error('onLog boom');
      },
      onToast: () => {
        throw new Error('onToast boom');
      }
    });

    expect(() => toast('Fallback toast works', true)).not.toThrow();

    const toastEl = document.getElementById('ala-toast');
    expect(toastEl).not.toBeNull();
    expect(toastEl?.textContent).toBe('Fallback toast works');
  });
});

describe('MAL API: Retry-After, Coalescing, Retry Budget & Logging (BUG-25..BUG-29)', () => {
  beforeEach(() => {
    store.del('mal_token');
    store.del('mal_refresh_token');
    store.del('mal_expires_at');
    store.del('mal_code_verifier');
    store.del('ala_mal_api_resume_at');
    store.del(`${SETTING_PREFIX}devModeEnabled`);
    store.del(`${SETTING_PREFIX}debug`);
    delete (window as any).__ALA_DEBUG__;
    delete (window as any).__ALFL_DEBUG__;
    malLimiter.until = 0;
    malLimiter.setRate(60);
    malLimiter.tokens = malLimiter.burst;
    malLimiter.last = Date.now();
    malLimiter.okStreak = 0;
    breaker.reset();
    setMalUiSink(null);
    vi.mocked(globalThis.GM_xmlhttpRequest).mockReset();
  });

  afterEach(() => {
    delete (window as any).__ALA_DEBUG__;
    delete (window as any).__ALFL_DEBUG__;
    store.del(`${SETTING_PREFIX}devModeEnabled`);
    store.del(`${SETTING_PREFIX}debug`);
    setMalUiSink(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('BUG-25: parseRetryAfterMs parses RFC 7231 HTTP-dates and trimmed numeric headers', () => {
    vi.useFakeTimers();
    const targetDate = 'Wed, 21 Oct 2026 07:28:00 GMT';
    const targetMs = Date.parse(targetDate);
    vi.setSystemTime(targetMs - 15_000);

    expect(parseRetryAfterMs(`Content-Type: text/plain\r\nRetry-After: ${targetDate}  \r\n`, 5000)).toBe(15_000);

    vi.setSystemTime(targetMs - 300_000);
    expect(parseRetryAfterMs(`retry-after: ${targetDate}`, 5000)).toBe(120_000);

    vi.setSystemTime(targetMs + 5_000);
    expect(parseRetryAfterMs(`retry-after: ${targetDate}`, 5000)).toBe(1000);

    expect(parseRetryAfterMs('X-Test: 1\r\nRetry-After:   12   \r\nX-End: 2', 5000)).toBe(12_000);
    expect(parseRetryAfterMs('Retry-After: 0', 5000)).toBe(1000);
    expect(parseRetryAfterMs('Retry-After: 999', 5000)).toBe(120_000);
    expect(parseRetryAfterMs('Retry-After:    \r\n', 5000)).toBe(5000);
    expect(parseRetryAfterMs('Retry-After: not-a-date', 5000)).toBe(5000);
    expect(parseRetryAfterMs('', 5000)).toBe(5000);
  });

  it('BUG-26: malEnsureToken() without failedToken coalesces onto an in-flight refresh', async () => {
    store.set('mal_token', 'T1');
    store.set('mal_refresh_token', 'R1');
    store.set('mal_expires_at', Date.now() + 3600_000);

    let resolveRefresh!: (res: any) => void;
    let refreshCalls = 0;

    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      expect(opts.url).toBe(MAL_TOKEN_URL);
      refreshCalls++;
      resolveRefresh = (res) => opts.onload?.(res);
    });

    const pRejected = malEnsureToken('T1');
    const pConcurrent = malEnsureToken();

    await vi.waitFor(() => {
      expect(refreshCalls).toBe(1);
    });

    resolveRefresh({
      status: 200,
      responseText: JSON.stringify({ access_token: 'T2', refresh_token: 'R2', expires_in: 3600 })
    });

    await expect(pRejected).resolves.toBe('T2');
    await expect(pConcurrent).resolves.toBe('T2');
    expect(refreshCalls).toBe(1);
  });

  it('BUG-27: malCall keeps retry budget across 401 refresh and backs off on non-rate-limited 5xx', async () => {
    vi.useFakeTimers();
    store.set('mal_token', 'T1');
    store.set('mal_refresh_token', 'R1');
    store.set('mal_expires_at', Date.now() + 3600_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // backoff(0) = 1000ms, limiter jitter = 1.05x

    // 1) retries=0 survives 401 -> refresh -> 500? No, 401 -> refresh -> 200 succeeds with retries=0.
    let apiAttempt = 0;
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      if (opts.url === MAL_TOKEN_URL) {
        opts.onload?.({
          status: 200,
          responseText: JSON.stringify({ access_token: 'T2', refresh_token: 'R2', expires_in: 3600 })
        });
        return;
      }
      apiAttempt++;
      if (apiAttempt === 1) {
        opts.onload?.({ status: 401, responseText: 'Unauthorized', responseHeaders: '' });
      } else {
        opts.onload?.({ status: 200, responseText: '{"ok":true}', responseHeaders: '' });
      }
    });

    const zeroRetryRes = await malCall({ url: `${MAL_API}/users/@me` }, 0);
    expect(zeroRetryRes.status).toBe(200);
    expect(apiAttempt).toBe(2);

    // 2) retries=1 survives 401 -> refresh -> 500 -> backoff(0) -> 200, proving 401 did not consume retry budget
    //    and 500 waits backoff(0) = 1000ms before calling malLimiter.acquire() for the retry.
    malLimiter.until = 0;
    malLimiter.setRate(60);
    malLimiter.tokens = malLimiter.burst;
    malLimiter.last = Date.now();
    store.del('ala_mal_api_resume_at');

    const acquireSpy = vi.spyOn(malLimiter, 'acquire');
    let calls5xx = 0;
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      if (opts.url === MAL_TOKEN_URL) {
        opts.onload?.({
          status: 200,
          responseText: JSON.stringify({ access_token: 'T3', refresh_token: 'R3', expires_in: 3600 })
        });
        return;
      }
      calls5xx++;
      if (calls5xx === 1) {
        opts.onload?.({ status: 401, responseText: 'Unauthorized', responseHeaders: '' });
      } else if (calls5xx === 2) {
        opts.onload?.({ status: 500, responseText: 'Server Error', responseHeaders: '' });
      } else {
        opts.onload?.({ status: 200, responseText: '{"recovered":true}', responseHeaders: '' });
      }
    });

    const p5xx = malCall({ url: `${MAL_API}/anime/1` }, 1);
    await vi.advanceTimersByTimeAsync(0);
    // 401 -> refresh -> 500 happened immediately without backoff sleep (acquire called twice: initial + post-401)
    expect(calls5xx).toBe(2);
    expect(acquireSpy).toHaveBeenCalledTimes(2);

    // During backoff(0) = 1000ms, retry acquire must NOT be called yet
    await vi.advanceTimersByTimeAsync(900);
    expect(acquireSpy).toHaveBeenCalledTimes(2);
    expect(calls5xx).toBe(2);

    // Once backoff(0) completes (at 1000ms), malCall calls malLimiter.acquire() for the retry
    await vi.advanceTimersByTimeAsync(150);
    expect(acquireSpy).toHaveBeenCalledTimes(3);

    // Advance past malLimiter cooldown + token refill (~3100ms remaining)
    await vi.advanceTimersByTimeAsync(4000);
    const res5xx = await p5xx;
    expect(res5xx.status).toBe(200);
    expect(calls5xx).toBe(3);
  });

  it('BUG-27: malCall does not double-sleep backoff on 429 and honors checkCancel before 5xx retry', async () => {
    vi.useFakeTimers();
    store.set('mal_token', 'T1');
    store.set('mal_expires_at', Date.now() + 3600_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const acquireSpy = vi.spyOn(malLimiter, 'acquire');
    let calls429 = 0;
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      calls429++;
      if (calls429 === 1) {
        opts.onload?.({ status: 429, responseText: 'Rate limited', responseHeaders: 'Retry-After: 2' });
      } else {
        opts.onload?.({ status: 200, responseText: '{"ok":true}', responseHeaders: '' });
      }
    });

    const p429 = malCall({ url: `${MAL_API}/anime/2` }, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls429).toBe(1);
    // 429 must immediately proceed to malLimiter.acquire() on the next loop without waiting backoff(0)
    expect(acquireSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    const r429 = await p429;
    expect(r429.status).toBe(200);
    expect(calls429).toBe(2);

    malLimiter.until = 0;
    malLimiter.setRate(60);
    malLimiter.tokens = malLimiter.burst;
    malLimiter.last = Date.now();
    store.del('ala_mal_api_resume_at');

    let cancelled = false;
    let callsCancelled = 0;
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      callsCancelled++;
      opts.onload?.({ status: 503, responseText: 'Unavailable', responseHeaders: '' });
    });

    const cancelErr = Object.assign(new Error('Cancelled'), { cancelled: true });
    const pCancel = malCall({ url: `${MAL_API}/anime/3` }, 2, () => {
      if (cancelled) throw cancelErr;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(callsCancelled).toBe(1);

    cancelled = true;
    const cancelAssertion = expect(pCancel).rejects.toThrow('Cancelled');
    await vi.advanceTimersByTimeAsync(1100);
    await cancelAssertion;
    expect(callsCancelled).toBe(1);
  });

  it('BUG-28: log() routes through createCoreLogger("mal") while preserving logLines, lastNotice, and uiSink', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sinkEntries: Array<{ line: string; message: string; level: string }> = [];

    setMalUiSink({
      onLog: (entry) => sinkEntries.push(entry)
    });

    log('silent info', 'info');
    log('silent success', 'success');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(lastNotice).toBe('silent success');
    expect(logLines[0]).toContain('silent success');
    expect(logLines[1]).toContain('silent info');
    expect(sinkEntries).toHaveLength(2);

    log('warn message', 'warn');
    log('error message', 'error');
    expect(warnSpy).toHaveBeenCalledWith('[MAL]', 'warn message');
    expect(errorSpy).toHaveBeenCalledWith('[MAL]', 'error message');

    store.set(`${SETTING_PREFIX}devModeEnabled`, true);
    store.set(`${SETTING_PREFIX}debug`, { core: { enabled: true, channels: { mal: true } } });

    log('debug enabled info', 'info');
    expect(debugSpy).toHaveBeenCalledWith('[MAL]', 'debug enabled info');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('BUG-29: malUpdateEntry omits undefined/null patch values while retaining 0 and empty strings', async () => {
    store.set('mal_token', 'T1');
    store.set('mal_expires_at', Date.now() + 3600_000);

    let capturedBody = '';
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      capturedBody = String(opts.data ?? '');
      opts.onload?.({ status: 200, responseText: '{"status":"watching"}', responseHeaders: '' });
    });

    await malUpdateEntry('ANIME', 123, {
      status: 'watching',
      score: 0,
      comments: '',
      start_date: undefined,
      finish_date: null,
      is_rewatching: false
    });

    const parsed = new URLSearchParams(capturedBody);
    expect(parsed.get('status')).toBe('watching');
    expect(parsed.get('score')).toBe('0');
    expect(parsed.get('comments')).toBe('');
    expect(parsed.get('is_rewatching')).toBe('false');
    expect(parsed.has('start_date')).toBe(false);
    expect(parsed.has('finish_date')).toBe(false);
    expect(capturedBody).not.toContain('undefined');
    expect(capturedBody).not.toContain('null');
  });
});

describe('MAL API: Per-Call MalCallOptions & AbortSignal Isolation (IMP-13)', () => {
  beforeEach(() => {
    hooks.checkCancel = undefined;
    store.set('mal_token', 'T1');
    store.del('mal_refresh_token');
    store.set('mal_expires_at', Date.now() + 3600_000);
    store.del('ala_mal_api_resume_at');
    malLimiter.until = 0;
    malLimiter.setRate(60);
    malLimiter.tokens = malLimiter.burst;
    malLimiter.last = Date.now();
    malLimiter.okStreak = 0;
    breaker.reset();
    setMalUiSink(null);
    vi.mocked(globalThis.GM_xmlhttpRequest).mockReset();
  });

  afterEach(() => {
    hooks.checkCancel = undefined;
    setMalUiSink(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('isolates explicit { signal } and { checkCancel } from global hooks.checkCancel across all MAL endpoints', async () => {
    const globalCancelErr = Object.assign(new Error('Global cancelled'), { cancelled: true });
    hooks.checkCancel = () => {
      throw globalCancelErr;
    };

    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      if (opts.url.includes('/users/@me/animelist')) {
        opts.onload?.({
          status: 200,
          responseHeaders: '',
          responseText: JSON.stringify({
            data: [{ node: { id: 42, title: 'Isolated Show', num_episodes: 12 }, list_status: { status: 'watching' } }]
          })
        });
        return;
      }
      if (opts.url.includes('/users/@me')) {
        opts.onload?.({ status: 200, responseHeaders: '', responseText: JSON.stringify({ id: 9, name: 'User' }) });
        return;
      }
      if (opts.url.includes('/anime?')) {
        opts.onload?.({
          status: 200,
          responseHeaders: '',
          responseText: JSON.stringify({
            data: [{ node: { id: 314, title: 'Isolated Search Match', start_date: '2024-01-01' } }]
          })
        });
        return;
      }
      opts.onload?.({ status: 200, responseHeaders: '', responseText: '{"status":"completed"}' });
    });

    // Without opts, malCall falls back to hooks.checkCancel
    await expect(malCall({ url: `${MAL_API}/users/@me` })).rejects.toThrow('Global cancelled');

    // With explicit { signal } or { checkCancel }, hooks.checkCancel is bypassed
    const ac = new AbortController();
    await expect(malWhoAmI({ signal: ac.signal })).resolves.toMatchObject({ id: 9 });
    await expect(malUpdateEntry('ANIME', 42, { status: 'completed' }, { signal: ac.signal })).resolves.toMatchObject({
      status: 200
    });
    await expect(malDeleteEntry('ANIME', 42, { checkCancel: () => {} })).resolves.toMatchObject({ status: 200 });
    const list = await malFetchList('ANIME', { signal: ac.signal });
    expect(list[42]?.__malTitle).toBe('Isolated Show');
    const foundId = await searchMalId(
      'ANIME',
      {
        queryTitles: ['Isolated Search Match'],
        titles: ['isolated search match'],
        startYear: 2024
      },
      { signal: ac.signal }
    );
    expect(foundId).toBe(314);
  });

  it('aborts cleanly across limiter cooldown, in-flight request, retry backoff, breaker.wait, and malFetchList pages', async () => {
    vi.useFakeTimers();

    // 1. Abort during rate limiter cooldown without waiting for cooldown to expire
    malLimiter.limit(30_000);
    const acLimiter = new AbortController();
    const pLimiter = malCall({ url: `${MAL_API}/users/@me` }, 1, { signal: acLimiter.signal });
    acLimiter.abort();
    await expect(pLimiter).rejects.toMatchObject({ cancelled: true });
    expect(vi.mocked(globalThis.GM_xmlhttpRequest)).not.toHaveBeenCalled();

    // Reset limiter
    malLimiter.until = 0;
    malLimiter.tokens = malLimiter.burst;
    malLimiter.last = Date.now();
    store.del('ala_mal_api_resume_at');

    // 2. Abort during in-flight GM_xmlhttpRequest
    const acFetch = new AbortController();
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation(() => {
      // Never resolves
    });
    const pFetch = malCall({ url: `${MAL_API}/anime/10` }, 0, { signal: acFetch.signal });
    await vi.advanceTimersByTimeAsync(0);
    acFetch.abort();
    await expect(pFetch).rejects.toMatchObject({ name: 'AbortError', cancelled: true });

    // 3. Abort during 5xx retry backoff sleep stops subsequent retries
    let retryReqCount = 0;
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      retryReqCount++;
      opts.onload?.({ status: 503, responseHeaders: '', responseText: 'Down' });
    });
    const acRetry = new AbortController();
    const pRetry = malCall({ url: `${MAL_API}/anime/11` }, 3, { signal: acRetry.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(retryReqCount).toBe(1);
    acRetry.abort();
    await expect(pRetry).rejects.toMatchObject({ cancelled: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retryReqCount).toBe(1);

    // 4. Abort during breaker.wait
    for (let i = 0; i < 8; i++) breaker.fail();
    const acBreaker = new AbortController();
    const pBreaker = breaker.wait({ signal: acBreaker.signal });
    acBreaker.abort();
    await expect(pBreaker).rejects.toMatchObject({ cancelled: true });
    breaker.reset();

    // 5. Abort between malFetchList pagination pages
    malLimiter.until = 0;
    malLimiter.tokens = malLimiter.burst;
    const acPages = new AbortController();
    let pageCalls = 0;
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      pageCalls++;
      acPages.abort();
      opts.onload?.({
        status: 200,
        responseHeaders: '',
        responseText: JSON.stringify({
          data: [{ node: { id: 1, title: 'Page 1' }, list_status: { status: 'watching' } }],
          paging: { next: 'https://api.myanimelist.net/v2/users/@me/animelist?offset=1' }
        })
      });
    });
    await expect(malFetchList('ANIME', { signal: acPages.signal })).rejects.toMatchObject({ cancelled: true });
    expect(pageCalls).toBe(1);
  });

  it('isolates concurrent searchCandidates callers with independent AbortSignals', async () => {
    let pendingOnload!: (res: any) => void;
    let searchCalls = 0;
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      searchCalls++;
      pendingOnload = (res) => opts.onload?.(res);
    });

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const key = 'ANIME:Shared Concurrent Query';

    const p1 = searchCandidates(key, 'ANIME', 'Shared Concurrent Query', { signal: ac1.signal });
    const p2 = searchCandidates(key, 'ANIME', 'Shared Concurrent Query', { signal: ac2.signal });

    await vi.waitFor(() => expect(searchCalls).toBe(1));

    // Aborting caller 1 rejects p1 immediately without cancelling caller 2
    ac1.abort();
    await expect(p1).rejects.toMatchObject({ cancelled: true });

    pendingOnload({
      status: 200,
      responseHeaders: '',
      responseText: JSON.stringify({
        data: [{ node: { id: 808, title: 'Shared Concurrent Query', start_date: '2025-04-01' } }]
      })
    });

    const cands = await p2;
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe(808);
    expect(searchCalls).toBe(1);
  });

  it('BUG-16: isolates searchCandidates waiters from Caller 1 checkCancel and global hooks.checkCancel', async () => {
    const pending: Array<(res: any) => void> = [];
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      pending.push((res) => opts.onload?.(res));
    });

    let caller1Cancelled = false;
    const caller1Err = Object.assign(new Error('Caller 1 checkCancel tripped'), { cancelled: true });
    let globalCancelled = false;
    const globalErr = Object.assign(new Error('Global hooks.checkCancel tripped'), { cancelled: true });
    hooks.checkCancel = () => {
      if (globalCancelled) throw globalErr;
    };

    const key = 'ANIME:BUG16 CheckCancel Isolation';
    const ac2 = new AbortController();

    // Caller 1 has an explicit checkCancel (which later trips), Caller 3 has no opts (falls back to hooks.checkCancel),
    // and Caller 2 has an independent AbortSignal.
    const p1 = searchCandidates(key, 'ANIME', 'BUG16 CheckCancel Isolation', {
      checkCancel: () => {
        if (caller1Cancelled) throw caller1Err;
      }
    });
    const p2 = searchCandidates(key, 'ANIME', 'BUG16 CheckCancel Isolation', { signal: ac2.signal });
    const p3 = searchCandidates(key, 'ANIME', 'BUG16 CheckCancel Isolation');

    await vi.waitFor(() => expect(pending).toHaveLength(1));

    // Tripping Caller 1's checkCancel or global hooks.checkCancel must not abort the shared flight for Caller 2.
    caller1Cancelled = true;
    globalCancelled = true;

    pending[0]({
      status: 200,
      responseHeaders: '',
      responseText: JSON.stringify({
        data: [{ node: { id: 901, title: 'BUG16 CheckCancel Isolation', start_date: '2025-01-01' } }]
      })
    });

    await expect(p1).rejects.toThrow('Caller 1 checkCancel tripped');
    await expect(p3).rejects.toThrow('Global hooks.checkCancel tripped');
    const res2 = await p2;
    expect(res2).toHaveLength(1);
    expect(res2[0].id).toBe(901);
    expect(pending).toHaveLength(1);
  });

  it('BUG-16: synchronously evicts aborted sole-waiter searchFlights so immediate re-entry starts a fresh flight', async () => {
    const pending: Array<(res: any) => void> = [];
    vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: GmRequestOpts) => {
      pending.push((res) => opts.onload?.(res));
    });

    const key = 'ANIME:BUG16 Sync Reentry';
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const p1 = searchCandidates(key, 'ANIME', 'BUG16 Sync Reentry', { signal: ac1.signal });
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    // Abort sole waiter and synchronously re-enter before any microtasks drain.
    ac1.abort();
    const p2 = searchCandidates(key, 'ANIME', 'BUG16 Sync Reentry', { signal: ac2.signal });

    await expect(p1).rejects.toMatchObject({ cancelled: true });
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    // Even if the stale first flight resolves late, p2 resolves cleanly from the fresh second flight.
    pending[0]({
      status: 200,
      responseHeaders: '',
      responseText: JSON.stringify({ data: [] })
    });
    pending[1]({
      status: 200,
      responseHeaders: '',
      responseText: JSON.stringify({
        data: [{ node: { id: 902, title: 'BUG16 Sync Reentry', start_date: '2025-02-01' } }]
      })
    });

    const res2 = await p2;
    expect(res2).toHaveLength(1);
    expect(res2[0].id).toBe(902);
  });

  it('BUG-16: breaker.wait() honors hooks.checkCancel fallback when no per-call cancel options are provided', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 8; i++) breaker.fail();

    let shouldCancel = false;
    const fallbackErr = Object.assign(new Error('Fallback hook cancelled breaker'), { cancelled: true });
    hooks.checkCancel = () => {
      if (shouldCancel) throw fallbackErr;
    };

    // Wait starts while uncancelled, then hooks.checkCancel trips during cooldown sleep.
    const waitNoArgs = breaker.wait();
    await vi.advanceTimersByTimeAsync(1000);
    shouldCancel = true;
    const waitAssertion = expect(waitNoArgs).rejects.toThrow('Fallback hook cancelled breaker');
    await vi.advanceTimersByTimeAsync(1000);
    await waitAssertion;

    // Empty options object also falls back to hooks.checkCancel immediately.
    await expect(breaker.wait({})).rejects.toThrow('Fallback hook cancelled breaker');

    // Explicit per-call checkCancel still overrides hooks.checkCancel.
    const ac = new AbortController();
    const explicitWait = breaker.wait({ signal: ac.signal });
    ac.abort();
    await expect(explicitWait).rejects.toMatchObject({ cancelled: true });
    breaker.reset();
  });
});
