import type { AddStyleFn, CleanupFn } from '../../types';
import { win, doc, navListeners, onNav } from './state';
import { CFG, stats, attempt, idle } from './config';

const patchedCreateFns = new WeakSet<Function>();

export function installLazyMedia(): CleanupFn {
  const restores: Array<() => void> = [];
  const lazify = (el: any) => {
    if (!el || el.nodeType !== 1) return;
    switch (el.localName) {
      case 'img':
        if (!el.hasAttribute('loading')) el.loading = 'lazy';
        if (!el.hasAttribute('decoding')) el.decoding = 'async';
        break;
      case 'iframe':
        if (!el.hasAttribute('loading')) el.loading = 'lazy';
        break;
      case 'video':
        if (!el.hasAttribute('preload')) el.preload = 'metadata';
        break;
    }
  };

  const seenTargets = new Set<any>();
  const patchCreate = (target: any) => {
    if (!target || seenTargets.has(target)) return;
    seenTargets.add(target);
    const orig = target.createElement;
    if (typeof orig !== 'function' || patchedCreateFns.has(orig)) return;
    const hadOwn = Object.prototype.hasOwnProperty.call(target, 'createElement');
    const origDesc = hadOwn ? Object.getOwnPropertyDescriptor(target, 'createElement') : undefined;
    const patched = function (this: any, tag: string, options?: ElementCreationOptions) {
      const el = orig.call(this, tag, options);
      try {
        lazify(el);
      } catch {
        /* ignore */
      }
      return el;
    };
    patchedCreateFns.add(patched);
    let installed = false;
    try {
      target.createElement = patched;
      installed = target.createElement === patched;
    } catch {
      try {
        Object.defineProperty(target, 'createElement', { value: patched, writable: true, configurable: true });
        installed = target.createElement === patched;
      } catch {
        /* ignore */
      }
    }
    if (installed) {
      restores.push(() => {
        if (target.createElement !== patched) return;
        if (!hadOwn) {
          try {
            delete target.createElement;
            return;
          } catch {
            /* fall through */
          }
        }
        if (origDesc) {
          try {
            Object.defineProperty(target, 'createElement', origDesc);
            return;
          } catch {
            /* fall through */
          }
        }
        try {
          target.createElement = orig;
        } catch {
          try {
            Object.defineProperty(target, 'createElement', { value: orig, writable: true, configurable: true });
          } catch {
            /* ignore */
          }
        }
      });
    }
  };

  patchCreate(win.Document?.prototype);
  patchCreate(win.HTMLDocument?.prototype);
  patchCreate(Document.prototype);
  patchCreate(doc);
  if (typeof document !== 'undefined' && document !== doc) patchCreate(document);

  const MEDIA_TAG = /<(?:img|iframe|video)[\s>/]/i;
  const MEDIA_SEL = 'img:not([loading]),iframe:not([loading]),video:not([preload])';
  const lazifyTree = (root: any) => {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    lazify(root);
    for (const el of root.querySelectorAll(MEDIA_SEL)) lazify(el);
  };

  const ElementProto = win.Element?.prototype || Element.prototype;

  attempt(() => {
    const desc = Object.getOwnPropertyDescriptor(ElementProto, 'innerHTML');
    if (!desc || !desc.set || !desc.configurable) return;
    const patchedSet = function (this: Element, value: any) {
      desc.set!.call(this, value);
      if (typeof value === 'string' && MEDIA_TAG.test(value)) {
        attempt(() => lazifyTree(this instanceof win.HTMLTemplateElement ? (this as HTMLTemplateElement).content : this));
      }
    };
    Object.defineProperty(ElementProto, 'innerHTML', {
      ...desc,
      set: patchedSet
    });
    restores.push(() => {
      const current = Object.getOwnPropertyDescriptor(ElementProto, 'innerHTML');
      if (current?.set === patchedSet) {
        Object.defineProperty(ElementProto, 'innerHTML', desc);
      }
    });
  });

  attempt(() => {
    const native = ElementProto.insertAdjacentHTML;
    if (typeof native !== 'function') return;
    const patchedInsert = function (this: Element, position: InsertPosition, html: string) {
      const r = native.call(this, position, html);
      if (typeof html === 'string' && MEDIA_TAG.test(html)) {
        const outer = /^(?:beforebegin|afterend)$/i.test(position);
        attempt(() => lazifyTree(outer ? this.parentNode : this));
      }
      return r;
    };
    ElementProto.insertAdjacentHTML = patchedInsert;
    restores.push(() => {
      if (ElementProto.insertAdjacentHTML === patchedInsert) {
        ElementProto.insertAdjacentHTML = native;
      }
    });
  });

  return () => {
    for (let i = restores.length - 1; i >= 0; i--) {
      attempt(restores[i]);
    }
  };
}

const ROW_GROUPS = [
  { selector: '.medialist .entry.row', h: 56 },
  { selector: '.medialist .entry-card', h: 220 },
  { selector: '.activity-entry', h: 160 }
];

function injectCSS(text: string): CleanupFn {
  try {
    if ('adoptedStyleSheets' in doc && typeof win.CSSStyleSheet !== 'undefined') {
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(text);
      (doc as any).adoptedStyleSheets = [...(doc as any).adoptedStyleSheets, sheet];
      return () => {
        attempt(() => {
          (doc as any).adoptedStyleSheets = ((doc as any).adoptedStyleSheets || []).filter((s: any) => s !== sheet);
        });
      };
    }
  } catch {
    /* fall through */
  }
  const style = doc.createElement('style');
  style.textContent = text;
  (doc.head || doc.documentElement).appendChild(style);
  return () => {
    attempt(() => style.remove());
  };
}

export function installRowSkipping(deps?: {
  addStyle?: AddStyleFn;
  listen?: (t: EventTarget, type: string, fn: any, opts?: any) => CleanupFn;
}): CleanupFn {
  let disposed = false;
  const rules = ROW_GROUPS.map(
    ({ selector, h }, i) => `
        ${selector} {
            content-visibility: auto;
            contain-intrinsic-height: auto var(--alfast-h${i}, ${h}px);
            overflow-clip-margin: 16px;
        }
        ${selector}:hover,
        ${selector}:focus-within {
            content-visibility: visible;
        }`
  ).join('\n');

  const cssText = `@supports (content-visibility: auto) and (contain-intrinsic-height: auto 1px) { ${rules} }`;
  const removeStyle = deps?.addStyle ? deps.addStyle(cssText) : injectCSS(cssText);

  const addListener =
    deps?.listen ??
    ((t: EventTarget, type: string, fn: any, opts?: any): CleanupFn => {
      t.addEventListener(type, fn, opts);
      return () => t.removeEventListener(type, fn, opts);
    });

  const measuredFor = ROW_GROUPS.map(() => '');
  let timers: any[] = [];
  let resizeTimer: any = 0;

  function measure() {
    if (disposed) return;
    const path = win.location.pathname;
    const vh = win.innerHeight || doc.documentElement.clientHeight;
    ROW_GROUPS.forEach(({ selector }, i) => {
      if (measuredFor[i] === path) return;
      let nodes;
      try {
        nodes = doc.querySelectorAll(selector);
      } catch {
        return;
      }
      let total = 0;
      let count = 0;
      for (const el of nodes as any) {
        const r = el.getBoundingClientRect();
        if (r.top > vh) break;
        if (r.height > 0 && r.bottom > 0) {
          total += r.height;
          if (++count >= 6) break;
        }
      }
      if (!count) return;
      doc.documentElement.style.setProperty(`--alfast-h${i}`, `${Math.max(1, Math.round(total / count))}px`);
      measuredFor[i] = path;
    });
  }

  function schedule() {
    timers.forEach(clearTimeout);
    timers = [];
    if (disposed) return;
    timers = [500, 1800, 4500].map((ms) =>
      setTimeout(
        () =>
          idle(win, () => {
            if (!disposed && !doc.hidden) measure();
          }),
        ms
      )
    );
  }

  onNav(schedule);
  const listenerCleanups: CleanupFn[] = [];
  if (doc.readyState !== 'loading') schedule();
  else listenerCleanups.push(addListener(doc, 'DOMContentLoaded', schedule, { once: true }));
  listenerCleanups.push(addListener(win, 'load', schedule, { once: true }));

  const onResize = () => {
    clearTimeout(resizeTimer);
    if (disposed) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = 0;
      if (disposed) return;
      measuredFor.fill('');
      schedule();
    }, 200);
  };
  listenerCleanups.push(addListener(win, 'resize', onResize, { passive: true }));
  listenerCleanups.push(addListener(win, 'orientationchange', onResize, { passive: true }));

  return () => {
    disposed = true;
    timers.forEach(clearTimeout);
    timers = [];
    clearTimeout(resizeTimer);
    resizeTimer = 0;
    const navIdx = navListeners.indexOf(schedule);
    if (navIdx >= 0) navListeners.splice(navIdx, 1);
    for (const unsub of listenerCleanups) attempt(unsub);
    attempt(removeStyle);
    attempt(() => {
      for (let i = 0; i < ROW_GROUPS.length; i++) {
        doc.documentElement?.style?.removeProperty(`--alfast-h${i}`);
      }
    });
  };
}

export function installObserverCoalescing(): CleanupFn {
  const Native = win.MutationObserver;
  if (typeof Native !== 'function') return () => {};

  let disposed = false;
  const states = new WeakMap();
  const activeTimers = new Set<any>();

  const ignoresRecords = (fn: any) => {
    if (typeof fn !== 'function' || fn.length !== 0) return false;
    try {
      const src = Function.prototype.toString.call(fn);
      if (/\barguments\b/.test(src)) return false;
      const params = /^[^(]*\(([^)]*)\)/.exec(src);
      return !params || params[1].trim() === '';
    } catch {
      return false;
    }
  };

  const isPageRoot = (t: any) => t === doc || t === doc.documentElement || t === doc.body;

  function schedule(st: any) {
    if (disposed || st.timer) return;
    const wait = Math.max(0, st.last + CFG.observerBatchMs - performance.now());
    const handle = setTimeout(() => {
      activeTimers.delete(handle);
      st.timer = 0;
      if (disposed || !st.queue.length) return;
      const records = st.queue.splice(0);
      stats.observerBatches++;
      stats.observerRecordsMerged += records.length;
      try {
        st.callback.call(st.self, records, st.self);
      } catch (e) {
        setTimeout(() => {
          throw e;
        });
      }
      st.last = performance.now();
    }, wait);
    st.timer = handle;
    activeTimers.add(handle);
  }

  class CoalescedMutationObserver extends (Native as typeof MutationObserver) {
    constructor(callback: any) {
      const st: any = {
        callback,
        eligible: ignoresRecords(callback),
        on: false,
        queue: [],
        timer: 0,
        last: -Infinity,
        self: null
      };
      super(
        typeof callback === 'function'
          ? (records: MutationRecord[]) => {
              if (disposed || !st.on) return callback.call(st.self, records, st.self);
              for (const r of records) st.queue.push(r);
              schedule(st);
            }
          : callback
      );
      st.self = this;
      states.set(this, st);
    }
    override observe(target: Node, options?: MutationObserverInit) {
      const st = states.get(this);
      if (st && !disposed && st.eligible && options && options.subtree && isPageRoot(target)) st.on = true;
      return super.observe(target, options);
    }
    override disconnect() {
      const st = states.get(this);
      if (st) {
        if (st.timer) {
          clearTimeout(st.timer);
          activeTimers.delete(st.timer);
          st.timer = 0;
        }
        st.queue.length = 0;
        st.on = false;
      }
      return super.disconnect();
    }
    override takeRecords(): MutationRecord[] {
      const st = states.get(this);
      const pending = super.takeRecords();
      return st ? st.queue.splice(0).concat(pending) : pending;
    }
  }

  try {
    Object.defineProperty(win, 'MutationObserver', {
      value: CoalescedMutationObserver,
      writable: true,
      configurable: true
    });
  } catch {
    win.MutationObserver = CoalescedMutationObserver;
  }

  return () => {
    disposed = true;
    for (const t of activeTimers) {
      clearTimeout(t);
    }
    activeTimers.clear();
    if (win.MutationObserver === CoalescedMutationObserver) {
      try {
        Object.defineProperty(win, 'MutationObserver', {
          value: Native,
          writable: true,
          configurable: true
        });
      } catch {
        win.MutationObserver = Native;
      }
    }
  };
}
