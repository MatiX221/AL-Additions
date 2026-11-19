import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAL_API,
  MAL_TOKEN_URL,
  breaker,
  log,
  logLines,
  lastNotice,
  malCall,
  malConnect,
  malEnsureToken,
  malLimiter,
  malRequest,
  setMalUiSink,
  toast
} from '../src/api/mal';
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
