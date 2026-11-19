import { safe, sleep, store } from './helpers';

export interface RateLimiterOptions {
  rate: number;
  min?: number;
  max?: number;
  burst?: number;
  adaptive?: boolean;
  jitter?: boolean;
  persistKey?: string | null;
}

export class RateLimiter {
  rate: number;
  min: number;
  max: number;
  burst: number;
  adaptive: boolean;
  jitter: boolean;
  persistKey: string | null;

  tokens: number;
  last: number;
  until: number;
  okStreak: number;
  queue: Promise<void>;

  constructor({ rate, min = 1, max = rate, burst = 1, adaptive = false, jitter = false, persistKey = null }: RateLimiterOptions) {
    const safeMin = Number.isFinite(min) && min > 0 ? min : 1;
    const fallbackMax = Number.isFinite(rate) && rate > safeMin ? rate : safeMin;
    const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : fallbackMax;
    const safeBurst = Number.isFinite(burst) && burst >= 1 ? burst : 1;

    this.min = safeMin;
    this.max = safeMax;
    this.burst = safeBurst;
    this.adaptive = Boolean(adaptive);
    this.jitter = Boolean(jitter);
    this.persistKey = persistKey ?? null;

    this.rate = Number.isFinite(rate) ? Math.min(this.max, Math.max(this.min, rate)) : this.min;
    this.tokens = this.burst;
    this.last = Date.now();
    this.until = 0;
    this.okStreak = 0;
    this.queue = Promise.resolve();
  }

  private readStoredUntil(): number {
    if (!this.persistKey) return 0;
    try {
      const raw = store.get<unknown>(this.persistKey, 0);
      const stored = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
      return Number.isFinite(stored) && stored > 0 ? stored : 0;
    } catch {
      return 0;
    }
  }

  get resumeAt(): number {
    const stored = this.readStoredUntil();
    const at = Math.max(this.until, stored);
    return at > Date.now() ? at : 0;
  }

  setRate(n: number): void {
    if (!Number.isFinite(n)) return;
    this.rate = Math.min(this.max, Math.max(this.min, n));
  }

  acquire(check?: () => void): Promise<void> {
    const run = this.queue.then(() => this._take(check));
    this.queue = run.catch(() => {});
    return run;
  }

  private async _take(check?: () => void): Promise<void> {
    for (;;) {
      check?.();
      const now = Date.now();
      const resume = this.resumeAt;
      if (resume) {
        this.tokens = 0;
        this.last = resume;
        await sleep(Math.min(1000, Math.max(0, resume - now)));
        continue;
      }
      const elapsed = Math.max(0, now - this.last);
      this.tokens = Math.min(this.burst, this.tokens + (elapsed / 60000) * this.rate);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.max(15, ((1 - this.tokens) / this.rate) * 60000));
    }
  }

  success(): void {
    if (this.adaptive && ++this.okStreak >= 25 && this.rate < this.max) {
      this.setRate(this.rate + Math.max(1, Math.round(this.rate * 0.1)));
      this.okStreak = 0;
    }
  }

  limit(ms: number): void {
    this.okStreak = 0;
    this.tokens = 0;
    if (this.adaptive) this.setRate(Math.floor(this.rate / 2));
    if (!Number.isFinite(ms) || !(ms > 0)) return;
    const next = Date.now() + ms * (this.jitter ? 0.9 + Math.random() * 0.3 : 1);
    if (!Number.isFinite(next)) return;
    const stored = this.readStoredUntil();
    this.until = Math.max(this.until, stored, next);
    if (this.persistKey && this.until > stored) {
      safe(() => store.set(this.persistKey!, this.until), 'persist cooldown');
    }
  }
}