import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '../src/utils/limiter';
import { store } from '../src/utils/helpers';

describe('RateLimiter: Construction & Configuration', () => {
  it('clamps rate between min and max options', () => {
    const under = new RateLimiter({ rate: 0.5, min: 2, max: 10 });
    expect(under.rate).toBe(2);

    const over = new RateLimiter({ rate: 50, min: 2, max: 10 });
    expect(over.rate).toBe(10);

    const normal = new RateLimiter({ rate: 5, min: 2, max: 10 });
    expect(normal.rate).toBe(5);
  });

  it('applies default parameters when omitted', () => {
    const limiter = new RateLimiter({ rate: 30 });
    expect(limiter.min).toBe(1);
    expect(limiter.max).toBe(30);
    expect(limiter.burst).toBe(1);
    expect(limiter.adaptive).toBe(false);
    expect(limiter.jitter).toBe(false);
    expect(limiter.persistKey).toBeNull();
    expect(limiter.tokens).toBe(1);
  });

  it('clamps manual rate updates within bounds', () => {
    const limiter = new RateLimiter({ rate: 10, min: 5, max: 20 });
    limiter.setRate(15);
    expect(limiter.rate).toBe(15);

    limiter.setRate(2);
    expect(limiter.rate).toBe(5);

    limiter.setRate(99);
    expect(limiter.rate).toBe(20);
  });
});

describe('RateLimiter: Token Consumption & Acquisition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows immediate consumption up to the burst limit', async () => {
    const limiter = new RateLimiter({ rate: 60, burst: 3 });

    await expect(limiter.acquire()).resolves.toBeUndefined();
    await expect(limiter.acquire()).resolves.toBeUndefined();
    await expect(limiter.acquire()).resolves.toBeUndefined();

    let acquired = false;
    limiter.acquire().then(() => {
      acquired = true;
    });

    expect(acquired).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(acquired).toBe(true);
  });

  it('executes queued requests in FIFO sequence', async () => {
    const limiter = new RateLimiter({ rate: 60, burst: 1 });
    const order: number[] = [];

    await limiter.acquire();

    limiter.acquire().then(() => order.push(1));
    limiter.acquire().then(() => order.push(2));
    limiter.acquire().then(() => order.push(3));

    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([1]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([1, 2]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([1, 2, 3]);
  });

  it('handles check callback errors and continues queue processing', async () => {
    const limiter = new RateLimiter({ rate: 60, burst: 1 });

    const failed = limiter.acquire(() => {
      throw new Error('Request cancelled');
    });

    await expect(failed).rejects.toThrow('Request cancelled');

    const next = limiter.acquire();
    await expect(next).resolves.toBeUndefined();
  });

  it('re-evaluates check() cancellation within 1000 ms on a rate: 1 limiter', async () => {
    const limiter = new RateLimiter({ rate: 1, burst: 1 });
    await limiter.acquire();

    let cancelled = false;
    const pending = limiter.acquire(() => {
      if (cancelled) throw new Error('Cancelled mid-wait');
    });
    const assertion = expect(pending).rejects.toThrow('Cancelled mid-wait');

    cancelled = true;
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('applies setRate() updates within 1000 ms on a rate: 1 limiter', async () => {
    const limiter = new RateLimiter({ rate: 1, min: 1, max: 60, burst: 1 });
    await limiter.acquire();

    let acquired = false;
    const pending = limiter.acquire().then(() => {
      acquired = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(acquired).toBe(false);

    limiter.setRate(60);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(acquired).toBe(true);
  });

  it('aborts { check, signal } waiters immediately without stalling this.queue (IMP-05)', async () => {
    const limiter = new RateLimiter({ rate: 1, burst: 1 });
    await limiter.acquire();

    // Already-aborted signal rejects immediately without queueing
    const preAc = new AbortController();
    preAc.abort();
    await expect(limiter.acquire({ signal: preAc.signal })).rejects.toMatchObject({ name: 'AbortError' });

    // Waiter A is sleeping for 1000ms chunks; Waiter B is queued behind A
    const acA = new AbortController();
    const pA = limiter.acquire({ signal: acA.signal });
    let acquiredB = false;
    const pB = limiter.acquire().then(() => {
      acquiredB = true;
    });

    // Advance 50ms so A is sleeping in _take, then abort A -> A rejects immediately without waiting 950ms
    await vi.advanceTimersByTimeAsync(50);
    acA.abort();
    await expect(pA).rejects.toMatchObject({ name: 'AbortError' });

    // Also test a waiter C aborted while queued behind B: rejects immediately and leaves tokens intact
    const acC = new AbortController();
    const pC = limiter.acquire({ signal: acC.signal });
    acC.abort();
    await expect(pC).rejects.toMatchObject({ name: 'AbortError' });

    // Let B finish its 60s token refill cleanly (1 token/min at rate: 1)
    expect(acquiredB).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await pB;
    expect(acquiredB).toBe(true);

    // Aborting during cooldown (resumeAt) also releases queue immediately for the next waiter
    const cooldownLimiter = new RateLimiter({ rate: 600, burst: 1 });
    cooldownLimiter.limit(500);
    const acCooldown = new AbortController();
    const pAbortedCooldown = cooldownLimiter.acquire({ signal: acCooldown.signal });
    let nextOk = false;
    const pNext = cooldownLimiter.acquire().then(() => {
      nextOk = true;
    });

    await vi.advanceTimersByTimeAsync(10);
    acCooldown.abort();
    await expect(pAbortedCooldown).rejects.toMatchObject({ name: 'AbortError' });

    // Only ~490ms remain on cooldown + 100ms for 1 token at rate: 600;
    // if the aborted waiter stalled the queue for 1000ms this would still be false at 600ms
    await vi.advanceTimersByTimeAsync(600);
    await pNext;
    expect(nextOk).toBe(true);

    // { check, signal } removes abort listener when check() throws before abort
    const checkAc = new AbortController();
    const removeCheckSpy = vi.spyOn(checkAc.signal, 'removeEventListener');
    await expect(
      cooldownLimiter.acquire({
        signal: checkAc.signal,
        check: () => {
          throw new Error('Check stopped');
        }
      })
    ).rejects.toThrow('Check stopped');
    expect(removeCheckSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('RateLimiter: Adaptive Scaling', () => {
  it('does not alter rate on success or limit when adaptive is false', () => {
    const limiter = new RateLimiter({ rate: 10, min: 2, max: 20, adaptive: false });

    for (let i = 0; i < 30; i++) limiter.success();
    expect(limiter.rate).toBe(10);

    limiter.limit(1000);
    expect(limiter.rate).toBe(10);
  });

  it('halves rate on limit down to min when adaptive is true', () => {
    const limiter = new RateLimiter({ rate: 20, min: 5, max: 40, adaptive: true });

    limiter.limit(1000);
    expect(limiter.rate).toBe(10);

    limiter.limit(1000);
    expect(limiter.rate).toBe(5);

    limiter.limit(1000);
    expect(limiter.rate).toBe(5);
  });

  it('increases rate after 25 consecutive successes up to max', () => {
    const limiter = new RateLimiter({ rate: 10, min: 2, max: 15, adaptive: true });

    for (let i = 0; i < 24; i++) limiter.success();
    expect(limiter.rate).toBe(10);

    limiter.success();
    expect(limiter.rate).toBe(11);
    expect(limiter.okStreak).toBe(0);

    limiter.setRate(15);
    for (let i = 0; i < 25; i++) limiter.success();
    expect(limiter.rate).toBe(15);
  });

  it('resets okStreak when limit is encountered', () => {
    const limiter = new RateLimiter({ rate: 10, adaptive: true });

    for (let i = 0; i < 20; i++) limiter.success();
    expect(limiter.okStreak).toBe(20);

    limiter.limit(500);
    expect(limiter.okStreak).toBe(0);
  });
});

describe('RateLimiter: Cooldowns & Coordinated Cooldown State', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.del('test_limiter_key');
  });

  afterEach(() => {
    vi.useRealTimers();
    store.del('test_limiter_key');
  });

  it('delays token acquisition until cooldown expires', async () => {
    const limiter = new RateLimiter({ rate: 60, burst: 1 });

    limiter.limit(2000);
    expect(limiter.resumeAt).toBeGreaterThan(Date.now());

    let acquired = false;
    limiter.acquire().then(() => {
      acquired = true;
    });

    await vi.advanceTimersByTimeAsync(1500);
    expect(acquired).toBe(false);

    await vi.advanceTimersByTimeAsync(1500);
    expect(acquired).toBe(true);
  });

  it('applies jitter range within expected bounds', () => {
    const limiter = new RateLimiter({ rate: 60, jitter: true });
    const now = Date.now();

    limiter.limit(10000);

    expect(limiter.until).toBeGreaterThanOrEqual(now + 9000);
    expect(limiter.until).toBeLessThanOrEqual(now + 12000);
  });

  it('persists and respects stored cooldown timestamps', () => {
    const key = 'test_limiter_key';
    const limiter = new RateLimiter({ rate: 60, persistKey: key });

    limiter.limit(5000);
    expect(store.get(key)).toBe(limiter.until);

    const futureTime = Date.now() + 10000;
    store.set(key, futureTime);

    expect(limiter.resumeAt).toBe(futureTime);
  });

  it('ignores zero or negative limit intervals', () => {
    const limiter = new RateLimiter({ rate: 10 });
    limiter.limit(0);
    expect(limiter.until).toBe(0);

    limiter.limit(-500);
    expect(limiter.until).toBe(0);
  });
});

describe('RateLimiter: Cross-Tab Cooldown Integrity & Bounds Safety (B1-24)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.del('test_limiter_key');
  });

  afterEach(() => {
    vi.useRealTimers();
    store.del('test_limiter_key');
  });

  it('sanitizes invalid constructor bounds (burst <= 0, NaN/Infinity rate/min/max) without spinning', async () => {
    const zeroBurst = new RateLimiter({ rate: 60, burst: 0 });
    expect(zeroBurst.burst).toBe(1);
    expect(zeroBurst.tokens).toBe(1);
    await expect(zeroBurst.acquire()).resolves.toBeUndefined();

    const badBounds = new RateLimiter({ rate: NaN, min: -5, max: NaN, burst: -3 });
    expect(badBounds.min).toBe(1);
    expect(badBounds.max).toBe(1);
    expect(badBounds.rate).toBe(1);
    expect(badBounds.burst).toBe(1);
    await expect(badBounds.acquire()).resolves.toBeUndefined();

    const inverted = new RateLimiter({ rate: 10, min: 5, max: 2 });
    expect(inverted.min).toBe(5);
    expect(inverted.max).toBe(5);
    expect(inverted.rate).toBe(5);
  });

  it('ignores non-finite setRate() and limit() values and clamps finite setRate(0) to min', () => {
    const limiter = new RateLimiter({ rate: 10, min: 2, max: 20, persistKey: 'test_limiter_key' });

    limiter.setRate(NaN);
    expect(limiter.rate).toBe(10);
    limiter.setRate(Infinity);
    expect(limiter.rate).toBe(10);
    limiter.setRate(0);
    expect(limiter.rate).toBe(2);

    limiter.limit(Infinity);
    expect(limiter.until).toBe(0);
    expect(store.get('test_limiter_key', null)).toBeNull();

    limiter.limit(NaN);
    expect(limiter.until).toBe(0);
    expect(store.get('test_limiter_key', null)).toBeNull();

    const jittered = new RateLimiter({ rate: 10, jitter: true });
    jittered.limit(Number.MAX_VALUE);
    expect(Number.isFinite(jittered.until)).toBe(true);
  });

  it('tolerates corrupted or throwing persistKey values in resumeAt', () => {
    const key = 'test_limiter_key';
    const limiter = new RateLimiter({ rate: 60, persistKey: key });

    store.set(key, 'not-a-number');
    expect(limiter.resumeAt).toBe(0);

    store.set(key, Infinity);
    expect(limiter.resumeAt).toBe(0);

    const spy = vi.spyOn(store, 'get').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    try {
      expect(limiter.resumeAt).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves a longer stored cross-tab cooldown when another instance records a shorter limit()', () => {
    const key = 'test_limiter_key';
    const tab1 = new RateLimiter({ rate: 60, persistKey: key });
    const tab3 = new RateLimiter({ rate: 60, persistKey: key });

    tab1.limit(60_000);
    const longUntil = tab1.until;
    expect(store.get(key)).toBe(longUntil);

    const setSpy = vi.spyOn(store, 'set');
    tab3.limit(2_000);

    expect(tab3.until).toBe(longUntil);
    expect(tab3.resumeAt).toBe(longUntil);
    expect(store.get(key)).toBe(longUntil);
    expect(setSpy).not.toHaveBeenCalled();

    tab3.limit(120_000);
    expect(tab3.until).toBeGreaterThan(longUntil);
    expect(store.get(key)).toBe(tab3.until);
    setSpy.mockRestore();
  });

  it('does not accumulate negative tokens if persistKey is cleared mid-cooldown or clock steps backward', async () => {
    const key = 'test_limiter_key';
    const limiter = new RateLimiter({ rate: 60, burst: 1, persistKey: key });

    store.set(key, Date.now() + 60_000);

    let acquired = false;
    const p = limiter.acquire().then(() => {
      acquired = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    store.del(key);
    await vi.advanceTimersByTimeAsync(500);

    expect(limiter.tokens).toBeGreaterThanOrEqual(0);
    expect(acquired).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(acquired).toBe(true);

    const tNow = Date.now();
    vi.setSystemTime(tNow - 30_000);
    let acquiredAfterSkew = false;
    const p2 = limiter.acquire().then(() => {
      acquiredAfterSkew = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(limiter.tokens).toBeGreaterThanOrEqual(0);
    await vi.advanceTimersByTimeAsync(1000);
    await p2;
    expect(acquiredAfterSkew).toBe(true);
  });
});