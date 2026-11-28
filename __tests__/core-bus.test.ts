import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastLoadCacheBridge } from '../src/types';

async function loadFreshBus() {
  vi.resetModules();
  const [bus, observer] = await Promise.all([
    import('../src/core/bus'),
    import('../src/core/observer')
  ]);
  return { ...bus, ...observer };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('B1-01: CoreHooks fallback fetch lifecycle & stacked wrappers', () => {
  it('survives outer wrapper stacking across markFetchOwner(true)/(false) re-installs and emits once per request', async () => {
    const origWinFetch = window.fetch;
    const { CoreHooks } = await loadFreshBus();

    const baseFetch = vi.fn(async function (this: any) {
      return new Response(JSON.stringify({ data: { Viewer: { id: 1 } } }), { status: 200 });
    });

    const events: Array<{ phase: string; query: string }> = [];
    let unsub: (() => void) | null = null;

    try {
      window.fetch = baseFetch as any;
      unsub = CoreHooks.onGqlFetch((ev) => {
        events.push({ phase: ev.phase, query: ev.query });
      });

      const innerWrapped = window.fetch;
      let outerCalls = 0;
      const outerWrapper = vi.fn(function (this: any, input: RequestInfo | URL, init?: RequestInit) {
        outerCalls++;
        return innerWrapped.call(this, input, init);
      });
      window.fetch = outerWrapper as any;

      const releaseOwner = CoreHooks.markFetchOwner(true);

      const ownerRes = await window.fetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query WhileOwner { Viewer { id } }' })
      });
      expect(ownerRes.status).toBe(200);
      expect(outerCalls).toBe(1);
      expect(baseFetch).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);

      const bareFetch = window.fetch;
      const bareRes = await bareFetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query BareCall { Viewer { id } }' })
      });
      expect(bareRes.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(2);
      expect(baseFetch.mock.contexts[1]).toBe(window);
      expect(events).toEqual([]);

      releaseOwner();
      const afterRes = await window.fetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query AfterYield { Viewer { id } }' })
      });
      expect(afterRes.status).toBe(200);
      expect(outerCalls).toBe(3);
      expect(baseFetch).toHaveBeenCalledTimes(3);
      expect(events).toEqual([
        { phase: 'request', query: 'query AfterYield { Viewer { id } }' },
        { phase: 'response', query: 'query AfterYield { Viewer { id } }' }
      ]);

      unsub();
      unsub = null;

      const postUnsubRes = await window.fetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query PostUnsub { Viewer { id } }' })
      });
      expect(postUnsubRes.status).toBe(200);
      expect(events).toHaveLength(2);
    } finally {
      unsub?.();
      CoreHooks.markFetchOwner(false);
      window.fetch = origWinFetch;
    }
  });

  it('emits zero events when uninstalled mid-flight during req.clone().text()', async () => {
    const origWinFetch = window.fetch;
    const origWinRequest = (window as any).Request;
    const { CoreHooks } = await loadFreshBus();

    class DeferredRequest {
      url: string;
      method = 'POST';
      bodyUsed = false;
      private readonly textPromise: Promise<string>;
      constructor(url: string, textPromise: Promise<string>) {
        this.url = url;
        this.textPromise = textPromise;
      }
      clone() {
        return { text: () => this.textPromise };
      }
    }

    const baseFetch = vi.fn(async () => new Response(JSON.stringify({ data: { Viewer: { id: 9 } } }), { status: 200 }));
    const events: any[] = [];
    let unsub: (() => void) | null = null;
    let releaseOwner: (() => void) | null = null;

    try {
      (window as any).Request = DeferredRequest;
      window.fetch = baseFetch as any;

      let resolveReqText1!: (v: string) => void;
      const reqTextPromise1 = new Promise<string>((r) => {
        resolveReqText1 = r;
      });
      unsub = CoreHooks.onGqlFetch((ev) => events.push(ev));

      const inflight1 = window.fetch(new DeferredRequest('https://anilist.co/graphql', reqTextPromise1) as any);
      unsub();
      unsub = null;

      resolveReqText1(JSON.stringify({ query: 'query MidUnsub { Viewer { id } }' }));
      const res1 = await inflight1;
      expect(res1.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);

      let resolveReqText2!: (v: string) => void;
      const reqTextPromise2 = new Promise<string>((r) => {
        resolveReqText2 = r;
      });
      unsub = CoreHooks.onGqlFetch((ev) => events.push(ev));

      const inflight2 = window.fetch(new DeferredRequest('https://anilist.co/graphql', reqTextPromise2) as any);
      releaseOwner = CoreHooks.markFetchOwner(true);

      resolveReqText2(JSON.stringify({ query: 'query MidOwner { Viewer { id } }' }));
      const res2 = await inflight2;
      expect(res2.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(2);
      expect(events).toEqual([]);
    } finally {
      unsub?.();
      releaseOwner?.();
      window.fetch = origWinFetch;
      (window as any).Request = origWinRequest;
    }
  });

  it('emits zero response events when uninstalled mid-flight during res.clone().json()', async () => {
    const origWinFetch = window.fetch;
    const { CoreHooks } = await loadFreshBus();

    let resolveResJson!: (v: any) => void;
    const resJsonPromise = new Promise<any>((r) => {
      resolveResJson = r;
    });

    const baseFetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      bodyUsed: false,
      clone: () => ({ json: () => resJsonPromise })
    }));

    const events: any[] = [];
    let unsub: (() => void) | null = null;

    try {
      window.fetch = baseFetch as any;
      unsub = CoreHooks.onGqlFetch((ev) => events.push(ev));

      const inflight = window.fetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query MidRes { Viewer { id } }' })
      });

      await Promise.resolve();
      expect(events.map((e) => e.phase)).toEqual(['request']);

      unsub();
      unsub = null;

      resolveResJson({ data: { Viewer: { id: 10 } } });
      await inflight;
      expect(events.map((e) => e.phase)).toEqual(['request']);
    } finally {
      unsub?.();
      window.fetch = origWinFetch;
    }
  });
});

describe('B1-02: Idempotent cleanups, snapshot dispatch & ServiceRegistry re-entrancy', () => {
  it('makes EventBus.on cleanups idempotent across re-subscriptions & identical callbacks and skips unsubscribed listeners during dispatch', async () => {
    const { EventBus } = await loadFreshBus();
    const calls: string[] = [];

    const sharedCb = (v: number) => calls.push(`shared:${v}`);

    const u1 = EventBus.on('manualOverrides:changed', sharedCb);
    u1();
    const u2 = EventBus.on('manualOverrides:changed', sharedCb);
    u1();

    EventBus.emit('manualOverrides:changed', 1);
    expect(calls).toEqual(['shared:1']);
    u2();

    calls.length = 0;
    const uA = EventBus.on('manualOverrides:changed', sharedCb);
    const uB = EventBus.on('manualOverrides:changed', sharedCb);
    uA();
    uA();
    EventBus.emit('manualOverrides:changed', 2);
    expect(calls).toEqual(['shared:2']);
    uB();

    calls.length = 0;
    let unsubSecond: () => void = () => {};
    const unsubFirst = EventBus.on('manualOverrides:changed', (v: number) => {
      calls.push(`first:${v}`);
      unsubSecond();
    });
    unsubSecond = EventBus.on('manualOverrides:changed', (v: number) => {
      calls.push(`second:${v}`);
    });

    EventBus.emit('manualOverrides:changed', 3);
    expect(calls).toEqual(['first:3']);
    unsubFirst();
    unsubSecond();
  });

  it('guards ServiceRegistry.onAvailable / provide against double-unsub, mid-dispatch unsub, and sync self-unsub cleanup leaks', async () => {
    const { ServiceRegistry } = await loadFreshBus();
    const svc = ServiceRegistry as any;
    const log: string[] = [];

    const sharedWatcher = (impl: any) => {
      log.push(`watch:${impl.id}`);
    };

    const w1 = svc.onAvailable('svc:bucket', sharedWatcher);
    w1();
    const w2 = svc.onAvailable('svc:bucket', sharedWatcher);
    w1();

    const p1 = svc.provide('svc:bucket', { id: 1 });
    expect(log).toEqual(['watch:1']);

    const sameImpl = { id: 2 };
    const pA = svc.provide('svc:sameImpl', sameImpl);
    pA();
    const pB = svc.provide('svc:sameImpl', sameImpl);
    pA();
    expect(svc.get('svc:sameImpl')).toBe(sameImpl);
    pB();
    p1();
    w2();

    log.length = 0;
    const wFirst = svc.onAvailable('svc:dup', sharedWatcher);
    const wSecond = svc.onAvailable('svc:dup', sharedWatcher);
    wFirst();
    wFirst();
    const pDup = svc.provide('svc:dup', { id: 3 });
    expect(log).toEqual(['watch:3']);
    pDup();
    wSecond();

    log.length = 0;
    let unsubW2: () => void = () => {};
    const unsubW1 = svc.onAvailable('svc:skip', () => {
      log.push('w1');
      unsubW2();
    });
    unsubW2 = svc.onAvailable('svc:skip', () => {
      log.push('w2');
    });
    const pSkip = svc.provide('svc:skip', {});
    expect(log).toEqual(['w1']);
    pSkip();
    unsubW1();

    log.length = 0;
    let uRe1: () => void = () => {};
    let uRe2: () => void = () => {};
    uRe1 = svc.onAvailable('svc:reprovide', (impl: { ver: number }) => {
      log.push(`re1:${impl.ver}`);
      return () => {
        log.push('re1:clean');
        uRe1();
        uRe2();
      };
    });
    uRe2 = svc.onAvailable('svc:reprovide', (impl: { ver: number }) => {
      log.push(`re2:${impl.ver}`);
      return () => log.push('re2:clean');
    });
    const pRe1 = svc.provide('svc:reprovide', { ver: 1 });
    const pRe2 = svc.provide('svc:reprovide', { ver: 2 });
    expect(log).toEqual(['re1:1', 're2:1', 're1:clean', 're2:clean']);
    pRe1();
    expect(svc.get('svc:reprovide')).toEqual({ ver: 2 });
    pRe2();

    const selfCleanups: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let unsubSelf: () => void = () => {};
      unsubSelf = svc.onAvailable('svc:selfUnsub', () => {
        unsubSelf();
        return () => {
          selfCleanups.push('cleaned');
          throw new Error('cleanup throw is isolated');
        };
      });
      const pSelf = svc.provide('svc:selfUnsub', { ok: true });
      expect(selfCleanups).toEqual(['cleaned']);
      expect(errSpy).toHaveBeenCalledTimes(1);
      pSelf();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('preserves overlapping sameImpl provide() registrations and guards re-entrant provide() inside onAvailable/runCleanup', async () => {
    const { ServiceRegistry } = await loadFreshBus();
    const svc = ServiceRegistry as any;

    const overlapLog: string[] = [];
    const sameImpl = { id: 99 };
    const wOverlap = svc.onAvailable('svc:overlapSameImpl', (impl: { id: number }) => {
      overlapLog.push(`avail:${impl.id}`);
      return () => overlapLog.push(`clean:${impl.id}`);
    });
    const pA = svc.provide('svc:overlapSameImpl', sameImpl);
    const pB = svc.provide('svc:overlapSameImpl', sameImpl);
    expect(overlapLog).toEqual(['avail:99', 'clean:99', 'avail:99']);

    pA();
    pA();
    expect(svc.get('svc:overlapSameImpl')).toBe(sameImpl);
    expect(overlapLog).toEqual(['avail:99', 'clean:99', 'avail:99']);

    pB();
    expect(svc.get('svc:overlapSameImpl')).toBeUndefined();
    expect(overlapLog).toEqual(['avail:99', 'clean:99', 'avail:99', 'clean:99']);
    wOverlap();

    const cbCleanLog: string[] = [];
    let p2FromCb: () => void = () => {};
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const wCb1 = svc.onAvailable('svc:reentrantCbCleanup', (impl: { ver: number }) => {
        cbCleanLog.push(`w1:${impl.ver}`);
        if (impl.ver === 1) {
          p2FromCb = svc.provide('svc:reentrantCbCleanup', { ver: 2 });
          return () => {
            cbCleanLog.push('w1:clean:1');
            throw new Error('stale cleanup1 error is isolated');
          };
        }
        return () => cbCleanLog.push('w1:clean:2');
      });
      const wCb2 = svc.onAvailable('svc:reentrantCbCleanup', (impl: { ver: number }) => {
        cbCleanLog.push(`w2:${impl.ver}`);
        return () => cbCleanLog.push(`w2:clean:${impl.ver}`);
      });

      const p1FromCb = svc.provide('svc:reentrantCbCleanup', { ver: 1 });
      expect(cbCleanLog).toEqual(['w1:1', 'w1:2', 'w2:2', 'w1:clean:1']);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(svc.get('svc:reentrantCbCleanup')).toEqual({ ver: 2 });

      p1FromCb();
      expect(svc.get('svc:reentrantCbCleanup')).toEqual({ ver: 2 });
      expect(cbCleanLog).toEqual(['w1:1', 'w1:2', 'w2:2', 'w1:clean:1']);

      p2FromCb();
      expect(svc.get('svc:reentrantCbCleanup')).toBeUndefined();
      expect(cbCleanLog).toEqual(['w1:1', 'w1:2', 'w2:2', 'w1:clean:1', 'w1:clean:2', 'w2:clean:2']);
      wCb1();
      wCb2();
    } finally {
      errSpy.mockRestore();
    }

    const cbUndefLog: string[] = [];
    let p2FromUndef: () => void = () => {};
    const wUndef1 = svc.onAvailable('svc:reentrantCbUndef', (impl: { ver: number }) => {
      cbUndefLog.push(`w1:${impl.ver}`);
      if (impl.ver === 1) {
        p2FromUndef = svc.provide('svc:reentrantCbUndef', { ver: 2 });
        return undefined;
      }
      return () => cbUndefLog.push('w1:clean:2');
    });
    const wUndef2 = svc.onAvailable('svc:reentrantCbUndef', (impl: { ver: number }) => {
      cbUndefLog.push(`w2:${impl.ver}`);
      return () => cbUndefLog.push(`w2:clean:${impl.ver}`);
    });

    const p1FromUndef = svc.provide('svc:reentrantCbUndef', { ver: 1 });
    expect(cbUndefLog).toEqual(['w1:1', 'w1:2', 'w2:2']);
    expect(svc.get('svc:reentrantCbUndef')).toEqual({ ver: 2 });

    p1FromUndef();
    expect(svc.get('svc:reentrantCbUndef')).toEqual({ ver: 2 });

    p2FromUndef();
    expect(svc.get('svc:reentrantCbUndef')).toBeUndefined();
    expect(cbUndefLog).toEqual(['w1:1', 'w1:2', 'w2:2', 'w1:clean:2', 'w2:clean:2']);
    wUndef1();
    wUndef2();

    const cleanupReLog: string[] = [];
    let p3FromCleanup: () => void = () => {};
    let triggeredCleanupProvide = false;
    const wRun1 = svc.onAvailable('svc:reentrantRunCleanup', (impl: { ver: number }) => {
      cleanupReLog.push(`w1:${impl.ver}`);
      return () => {
        cleanupReLog.push(`w1:clean:${impl.ver}`);
        if (!triggeredCleanupProvide) {
          triggeredCleanupProvide = true;
          p3FromCleanup = svc.provide('svc:reentrantRunCleanup', { ver: 3 });
        }
      };
    });
    const wRun2 = svc.onAvailable('svc:reentrantRunCleanup', (impl: { ver: number }) => {
      cleanupReLog.push(`w2:${impl.ver}`);
      return () => cleanupReLog.push(`w2:clean:${impl.ver}`);
    });

    const p1Run = svc.provide('svc:reentrantRunCleanup', { ver: 1 });
    const p2Run = svc.provide('svc:reentrantRunCleanup', { ver: 2 });
    expect(cleanupReLog).toEqual(['w1:1', 'w2:1', 'w1:clean:1', 'w1:3', 'w2:clean:1', 'w2:3']);
    expect(svc.get('svc:reentrantRunCleanup')).toEqual({ ver: 3 });

    p1Run();
    p2Run();
    expect(svc.get('svc:reentrantRunCleanup')).toEqual({ ver: 3 });

    p3FromCleanup();
    expect(svc.get('svc:reentrantRunCleanup')).toBeUndefined();
    expect(cleanupReLog).toEqual([
      'w1:1',
      'w2:1',
      'w1:clean:1',
      'w1:3',
      'w2:clean:1',
      'w2:3',
      'w1:clean:3',
      'w2:clean:3'
    ]);
    wRun1();
    wRun2();

    const immCleanLog: string[] = [];
    let pImm2: () => void = () => {};
    const pImm1 = svc.provide('svc:reentrantImmClean', { ver: 1 });
    const wImm1 = svc.onAvailable('svc:reentrantImmClean', (impl: { ver: number }) => {
      immCleanLog.push(`avail:${impl.ver}`);
      if (impl.ver === 1) {
        pImm2 = svc.provide('svc:reentrantImmClean', { ver: 2 });
        return () => immCleanLog.push('clean:1');
      }
      return () => immCleanLog.push('clean:2');
    });
    expect(immCleanLog).toEqual(['avail:1', 'avail:2', 'clean:1']);
    pImm1();
    expect(svc.get('svc:reentrantImmClean')).toEqual({ ver: 2 });
    pImm2();
    expect(immCleanLog).toEqual(['avail:1', 'avail:2', 'clean:1', 'clean:2']);
    wImm1();

    const immUndefLog: string[] = [];
    let pImmUndef2: () => void = () => {};
    const pImmUndef1 = svc.provide('svc:reentrantImmUndef', { ver: 1 });
    const wImmUndef = svc.onAvailable('svc:reentrantImmUndef', (impl: { ver: number }) => {
      immUndefLog.push(`avail:${impl.ver}`);
      if (impl.ver === 1) {
        pImmUndef2 = svc.provide('svc:reentrantImmUndef', { ver: 2 });
        return undefined;
      }
      return () => immUndefLog.push('clean:2');
    });
    expect(immUndefLog).toEqual(['avail:1', 'avail:2']);
    pImmUndef1();
    pImmUndef2();
    expect(immUndefLog).toEqual(['avail:1', 'avail:2', 'clean:2']);
    wImmUndef();

    const unprovideReLog: string[] = [];
    let p2OnUnprovide: () => void = () => {};
    let triggeredUnprovideRe = false;
    const wUnprov1 = svc.onAvailable('svc:reprovideOnUnprovide', (impl: { ver: number }) => {
      unprovideReLog.push(`w1:${impl.ver}`);
      return () => {
        unprovideReLog.push(`w1:clean:${impl.ver}`);
        if (!triggeredUnprovideRe) {
          triggeredUnprovideRe = true;
          p2OnUnprovide = svc.provide('svc:reprovideOnUnprovide', { ver: 2 });
        }
      };
    });
    const wUnprov2 = svc.onAvailable('svc:reprovideOnUnprovide', (impl: { ver: number }) => {
      unprovideReLog.push(`w2:${impl.ver}`);
      return () => unprovideReLog.push(`w2:clean:${impl.ver}`);
    });
    const p1Unprov = svc.provide('svc:reprovideOnUnprovide', { ver: 1 });
    p1Unprov();
    expect(svc.get('svc:reprovideOnUnprovide')).toEqual({ ver: 2 });
    expect(unprovideReLog).toEqual(['w1:1', 'w2:1', 'w1:clean:1', 'w1:2', 'w2:clean:1', 'w2:2']);
    p2OnUnprovide();
    expect(unprovideReLog).toEqual([
      'w1:1',
      'w2:1',
      'w1:clean:1',
      'w1:2',
      'w2:clean:1',
      'w2:2',
      'w1:clean:2',
      'w2:clean:2'
    ]);
    wUnprov1();
    wUnprov2();
  });

  it('guards CoreHooks.onGqlFetch and blockRpc against double-unsub and mid-dispatch removal', async () => {
    const origWinFetch = window.fetch;
    const { CoreHooks } = await loadFreshBus();
    const baseFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    window.fetch = baseFetch as any;

    try {
      const seen: string[] = [];
      const sharedGqlCb = (ev: any) => seen.push(ev.query);
      const u1 = CoreHooks.onGqlFetch(sharedGqlCb);
      const u2 = CoreHooks.onGqlFetch(sharedGqlCb);
      u1();
      u1();
      expect(CoreHooks.hasGqlFetchSubscribers()).toBe(true);

      CoreHooks.emitGqlFetch({ phase: 'request', url: '/graphql', query: 'q1', variables: {} });
      expect(seen).toEqual(['q1']);
      u2();
      expect(CoreHooks.hasGqlFetchSubscribers()).toBe(false);

      seen.length = 0;
      let uGql2: () => void = () => {};
      const uGql1 = CoreHooks.onGqlFetch(() => {
        seen.push('g1');
        uGql2();
      });
      uGql2 = CoreHooks.onGqlFetch(() => {
        seen.push('g2');
      });
      CoreHooks.emitGqlFetch({ phase: 'request', url: '/graphql', query: 'q2', variables: {} });
      expect(seen).toEqual(['g1']);
      uGql1();

      const sharedBlocker = (_q: string, v: Record<string, any>) => v.block === true;
      const b1 = CoreHooks.blockRpc(sharedBlocker);
      b1();
      const b2 = CoreHooks.blockRpc(sharedBlocker);
      b1();
      expect(CoreHooks.isRpcBlocked('q', { block: true })).toBe(true);
      b2();

      const blockerLog: string[] = [];
      let uBlk2: () => void = () => {};
      const uBlk1 = CoreHooks.blockRpc(() => {
        blockerLog.push('b1');
        uBlk2();
        return false;
      });
      uBlk2 = CoreHooks.blockRpc(() => {
        blockerLog.push('b2');
        return true;
      });
      expect(CoreHooks.isRpcBlocked('q', {})).toBe(false);
      expect(blockerLog).toEqual(['b1']);
      uBlk1();
    } finally {
      window.fetch = origWinFetch;
    }
  });

  it('preserves overlapping CoreHooks.registerCacheBridge registrations with the same bridge reference', async () => {
    const { CoreHooks } = await loadFreshBus();
    const clearAuth = vi.fn();
    const sameBridge: FastLoadCacheBridge = {
      getGqlStore: () => undefined,
      getRpcCache: () => undefined,
      getRpcInflight: () => undefined,
      getUserMap: () => undefined,
      getIdMap: () => undefined,
      clear: vi.fn(),
      clearAuth
    };

    const cA = CoreHooks.registerCacheBridge(sameBridge);
    const cB = CoreHooks.registerCacheBridge(sameBridge);

    cA();
    cA();
    expect(CoreHooks.getCacheBridge()).toBe(sameBridge);
    expect((globalThis as any).__alaCoreMirror?.hasCacheBridge).toBe(true);

    CoreHooks.clearAuth();
    expect(clearAuth).toHaveBeenCalledTimes(1);

    cB();
    cB();
    expect(CoreHooks.getCacheBridge()).toBeNull();
    expect((globalThis as any).__alaCoreMirror?.hasCacheBridge).toBe(false);

    CoreHooks.clearAuth();
    expect(clearAuth).toHaveBeenCalledTimes(1);
  });

  it('guards Core.onNavigate and Core.onBodyMutation against double-unsub with identical callbacks and mid-dispatch unsub', async () => {
    const origPushState = window.history.pushState;
    const origReplaceState = window.history.replaceState;
    const origPath = location.pathname + location.search;

    try {
      const { Core } = await loadFreshBus();

      const navCalls: string[] = [];
      const sharedNav = () => navCalls.push(location.pathname);

      const n1 = Core.onNavigate(sharedNav);
      n1();
      const n2 = Core.onNavigate(sharedNav);
      n1();

      window.history.pushState({}, '', '/anime/101');
      expect(navCalls).toEqual(['/anime/101']);
      n2();

      navCalls.length = 0;
      const nA = Core.onNavigate(sharedNav);
      const nB = Core.onNavigate(sharedNav);
      nA();
      nA();
      window.history.pushState({}, '', '/anime/102');
      expect(navCalls).toEqual(['/anime/102']);
      nB();

      navCalls.length = 0;
      let nSecond: () => void = () => {};
      const nFirst = Core.onNavigate(() => {
        navCalls.push('first');
        nSecond();
      });
      nSecond = Core.onNavigate(() => {
        navCalls.push('second');
      });
      window.history.pushState({}, '', '/anime/103');
      expect(navCalls).toEqual(['first']);
      nFirst();

      vi.useFakeTimers();
      const bodyCalls: string[] = [];
      const sharedBody = (recs: MutationRecord[]) => bodyCalls.push(`recs:${recs.length}`);

      const m1 = Core.onBodyMutation(sharedBody);
      m1();
      const m2 = Core.onBodyMutation(sharedBody);
      m1();

      const node1 = document.createElement('div');
      document.body.appendChild(node1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      expect(bodyCalls).toEqual(['recs:1']);
      m2();

      bodyCalls.length = 0;
      const mA = Core.onBodyMutation(sharedBody);
      const mB = Core.onBodyMutation(sharedBody);
      mA();
      mA();
      document.body.appendChild(document.createElement('span'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      expect(bodyCalls).toEqual(['recs:1']);
      mB();

      bodyCalls.length = 0;
      let mSecond: () => void = () => {};
      const mFirst = Core.onBodyMutation(() => {
        bodyCalls.push('m1');
        mSecond();
      });
      mSecond = Core.onBodyMutation(() => {
        bodyCalls.push('m2');
      });
      document.body.appendChild(document.createElement('p'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      expect(bodyCalls).toEqual(['m1']);
      mFirst();
    } finally {
      vi.useRealTimers();
      window.history.replaceState({}, '', origPath);
      window.history.pushState = origPushState;
      window.history.replaceState = origReplaceState;
    }
  });
});

describe('B1-03: CoreHooks.isRpcBlocked & emitGqlFetch contract normalization', () => {
  it('normalizes missing or non-plain-object variables and query in isRpcBlocked and isolates throwing blockers', async () => {
    const { CoreHooks } = await loadFreshBus();
    const received: Array<{ query: string; variables: Record<string, any> }> = [];

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unsubThrow = CoreHooks.blockRpc(() => {
      throw new Error('blocker crash');
    });
    const unsubRecord = CoreHooks.blockRpc((query, variables) => {
      received.push({ query, variables });
      return Object.keys(variables).length === 0 && variables.missingProp === undefined;
    });

    try {
      expect(CoreHooks.isRpcBlocked(undefined as any, undefined as any)).toBe(true);
      expect(CoreHooks.isRpcBlocked(null as any, [] as any)).toBe(true);
      expect(CoreHooks.isRpcBlocked(123 as any, 'bad' as any)).toBe(true);
      expect(CoreHooks.isRpcBlocked('query OK', { id: 42 })).toBe(false);

      expect(received).toEqual([
        { query: '', variables: {} },
        { query: '', variables: {} },
        { query: '123', variables: {} },
        { query: 'query OK', variables: { id: 42 } }
      ]);
      expect(errSpy).toHaveBeenCalledTimes(4);
    } finally {
      unsubThrow();
      unsubRecord();
      errSpy.mockRestore();
    }
  });

  it('normalizes query and variables in CoreHooks.emitGqlFetch and fallback fetch events', async () => {
    const origWinFetch = window.fetch;
    const { CoreHooks } = await loadFreshBus();
    const seen: any[] = [];
    const baseFetch = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    window.fetch = baseFetch as any;

    const unsub = CoreHooks.onGqlFetch((ev) => seen.push(ev));
    try {
      const rawInput = {
        phase: 'request' as const,
        url: '/graphql',
        query: undefined as any,
        variables: [] as any
      };
      CoreHooks.emitGqlFetch(rawInput);
      CoreHooks.emitGqlFetch({
        phase: 'response',
        url: '/graphql',
        query: 404 as any,
        variables: 'bad' as any
      });
      expect(Array.isArray(rawInput.variables)).toBe(true);
      expect(rawInput.query).toBeUndefined();

      await window.fetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query ArrayVars { Viewer { id } }', variables: ['invalid'] })
      });

      expect(seen.map((e) => ({ phase: e.phase, query: e.query, variables: e.variables }))).toEqual([
        { phase: 'request', query: '', variables: {} },
        { phase: 'response', query: '404', variables: {} },
        { phase: 'request', query: 'query ArrayVars { Viewer { id } }', variables: {} },
        { phase: 'response', query: 'query ArrayVars { Viewer { id } }', variables: {} }
      ]);
    } finally {
      unsub();
      window.fetch = origWinFetch;
    }
  });

  it('IMP-10: populates GqlFetchEvent.errors on HTTP 200 GraphQL error payloads in installFallbackFetch', async () => {
    const origWinFetch = window.fetch;
    const { CoreHooks } = await loadFreshBus();
    const events: any[] = [];
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { DeleteMediaListEntry: null },
            errors: [{ message: 'Entry not found', status: 404 }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { DeleteMediaListEntry: { deleted: true } },
            errors: 'non-array-ignored'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    window.fetch = baseFetch as any;

    const unsub = CoreHooks.onGqlFetch((ev) => events.push(ev));
    try {
      await window.fetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'mutation { DeleteMediaListEntry(id: 1) { deleted } }', variables: { id: 1 } })
      });
      await window.fetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'mutation { DeleteMediaListEntry(id: 2) { deleted } }', variables: { id: 2 } })
      });

      const responses = events.filter((e) => e.phase === 'response');
      expect(responses).toHaveLength(2);
      expect(responses[0].ok).toBe(true);
      expect(responses[0].status).toBe(200);
      expect(responses[0].data).toEqual({ DeleteMediaListEntry: null });
      expect(responses[0].errors).toEqual([{ message: 'Entry not found', status: 404 }]);
      expect(responses[1].errors).toBeUndefined();
    } finally {
      unsub();
      window.fetch = origWinFetch;
    }
  });
});

describe('CoreHooks authHeader & AccountProvider transition watching', () => {
  it('validates Bearer tokens in getAuthHeader/setAuthHeader, respects isSessionClearing(), and clears on clearAuth()', async () => {
    const { CoreHooks } = await loadFreshBus();
    const { store } = await import('../src/utils/helpers');

    expect(CoreHooks.getAuthHeader()).toBeNull();

    CoreHooks.setAuthHeader('Bearer valid_jwt_123');
    expect(CoreHooks.getAuthHeader()).toBe('Bearer valid_jwt_123');

    CoreHooks.setAuthHeader('Bearer ');
    CoreHooks.setAuthHeader('Bearer   ');
    CoreHooks.setAuthHeader('   ');
    expect(CoreHooks.getAuthHeader()).toBe('Bearer valid_jwt_123');

    CoreHooks.setSessionClearing(true);
    try {
      CoreHooks.setAuthHeader('Bearer ignored_during_clear');
      expect(CoreHooks.getAuthHeader()).toBe('Bearer valid_jwt_123');
    } finally {
      CoreHooks.setSessionClearing(false);
    }

    CoreHooks.setAuthHeader(null);
    expect(CoreHooks.getAuthHeader()).toBeNull();
    expect(store.get('al_token_auth', null)).toBeNull();

    CoreHooks.setAuthHeader('Bearer to_clear');
    CoreHooks.clearAuth();
    expect(CoreHooks.getAuthHeader()).toBeNull();
  });

  it('BUG-01: enforces Bearer prefix on setAuthHeader/getAuthHeader and handles null, undefined, and case-insensitive Bearer', async () => {
    const { CoreHooks } = await loadFreshBus();
    const { store } = await import('../src/utils/helpers');
    const rawJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.sig';

    for (const invalid of ['Bearer', 'Bearer   ', 'Basic abc', rawJwt, 123 as any]) {
      CoreHooks.setAuthHeader(invalid);
      expect(CoreHooks.getAuthHeader()).toBeNull();
      expect(store.get('al_token_auth', null)).toBeNull();
    }

    CoreHooks.setAuthHeader('  bearer tok  ');
    expect(store.get('al_token_auth', null)).toBe('bearer tok');
    expect(CoreHooks.getAuthHeader()).toBe('bearer tok');

    for (const invalid of ['Bearer', 'Bearer   ', 'Basic abc', rawJwt, { token: 'x' } as any]) {
      CoreHooks.setAuthHeader(invalid);
      expect(CoreHooks.getAuthHeader()).toBe('bearer tok');
      expect(store.get('al_token_auth', null)).toBe('bearer tok');
    }

    CoreHooks.setAuthHeader(null);
    expect(CoreHooks.getAuthHeader()).toBeNull();
    expect(store.get('al_token_auth', null)).toBeNull();

    CoreHooks.setAuthHeader('bearer tok');
    expect(CoreHooks.getAuthHeader()).toBe('bearer tok');

    CoreHooks.setAuthHeader(undefined as any);
    expect(CoreHooks.getAuthHeader()).toBeNull();
    expect(store.get('al_token_auth', null)).toBeNull();

    for (const invalidStored of ['Bearer', 'Bearer   ', 'Basic abc', rawJwt, 42]) {
      store.set('al_token_auth', invalidStored);
      expect(CoreHooks.getAuthHeader()).toBeNull();
    }

    store.set('al_token_auth', '  bearer tok  ');
    expect(CoreHooks.getAuthHeader()).toBe('bearer tok');
  });

  it('notifies watchAccountProvider only on isConnected() transitions and supports deferred registration', async () => {
    vi.resetModules();
    const [accounts, helpers] = await Promise.all([
      import('../src/core/accounts'),
      import('../src/utils/helpers')
    ]);

    const transitions: boolean[] = [];
    const unsub = accounts.watchAccountProvider('deferredSvc', (connected) => {
      transitions.push(connected);
    });

    const unregister = accounts.registerAccountProvider({
      id: 'deferredSvc',
      name: 'Deferred Service',
      secretKeys: ['def_verifier', 'def_token', 'def_refresh'],
      isConnected: () => !!helpers.store.get('def_token', null),
      connect: () => {},
      disconnect: () => {
        helpers.store.del('def_token');
        helpers.store.del('def_refresh');
      }
    });

    helpers.store.set('def_verifier', 'abc123');
    expect(transitions).toEqual([]);

    helpers.store.set('def_token', 'tok_1');
    expect(transitions).toEqual([true]);

    helpers.store.set('def_token', 'tok_2');
    helpers.store.set('def_refresh', 'ref_2');
    expect(transitions).toEqual([true]);

    helpers.store.del('def_token');
    helpers.store.del('def_refresh');
    expect(transitions).toEqual([true, false]);

    helpers.store.set('def_token', 'tok_3');
    expect(transitions).toEqual([true, false, true]);
    unregister();
    expect(transitions).toEqual([true, false, true, false]);

    unsub();
  });
});

describe('IMP-16: Multi-owner CoreHooks.markFetchOwner leases', () => {
  it('isolates per-caller fetch owner tokens and ignores legacy markFetchOwner(false) while leases remain', async () => {
    const origWinFetch = window.fetch;
    const { CoreHooks } = await loadFreshBus();

    const baseFetch = vi.fn(async () => new Response(JSON.stringify({ data: { Viewer: { id: 1 } } }), { status: 200 }));
    const events: string[] = [];
    let unsub: (() => void) | null = null;
    let releaseA: (() => void) | null = null;
    let releaseB: (() => void) | null = null;

    try {
      window.fetch = baseFetch as any;
      unsub = CoreHooks.onGqlFetch((ev) => events.push(ev.phase));

      releaseA = CoreHooks.markFetchOwner(true);
      releaseB = CoreHooks.markFetchOwner(true);
      expect((window as any).__alaCoreMirror?.fetchOwner).toBe(true);
      expect(window.fetch).toBe(baseFetch);

      // Legacy markFetchOwner(false) must not wipe active leases
      const noopCleanup = CoreHooks.markFetchOwner(false);
      expect(typeof noopCleanup).toBe('function');
      noopCleanup();
      expect((window as any).__alaCoreMirror?.fetchOwner).toBe(true);
      expect(window.fetch).toBe(baseFetch);

      // Releasing A twice keeps B active
      releaseA();
      releaseA();
      expect((window as any).__alaCoreMirror?.fetchOwner).toBe(true);
      expect(window.fetch).toBe(baseFetch);

      // Releasing B restores fallback fetch when listeners exist
      releaseB();
      expect((window as any).__alaCoreMirror?.fetchOwner).toBe(false);
      expect(window.fetch).not.toBe(baseFetch);

      await window.fetch('https://anilist.co/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query Restored { Viewer { id } }' })
      });
      expect(events).toEqual(['request', 'response']);
    } finally {
      releaseA?.();
      releaseB?.();
      unsub?.();
      window.fetch = origWinFetch;
    }
  });
});
