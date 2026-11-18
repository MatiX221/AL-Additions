import { vi, beforeEach } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { CompressionStream, DecompressionStream } from 'node:stream/web';

type ValueChangeCb = (key: string, oldVal: any, newVal: any, remote: boolean) => void;

declare global {
  var GM_getValue: any;
  var GM_setValue: any;
  var GM_deleteValue: any;
  var GM_listValues: any;
  var GM_addValueChangeListener: any;
  var GM_removeValueChangeListener: any;
  var GM_xmlhttpRequest: any;
  var GM_registerMenuCommand: any;
  var GM_download: any;
  var __MONKEY_WINDOW_KEY__: string;
}

const storage = new Map<string, any>();
const valueListeners = new Map<number, { key: string; cb: ValueChangeCb }>();
let nextListenerId = 1;

function notifyValueListeners(key: string, oldVal: any, newVal: any): void {
  for (const entry of [...valueListeners.values()]) {
    if (entry.key === key) {
      entry.cb(key, oldVal, newVal, false);
    }
  }
}

const gmGetValue = vi.fn((key: string, def?: any) => {
  return storage.has(key) ? storage.get(key) : def;
});

const gmSetValue = vi.fn((key: string, val: any) => {
  const oldVal = storage.has(key) ? storage.get(key) : undefined;
  storage.set(key, val);
  notifyValueListeners(key, oldVal, val);
});

const gmDeleteValue = vi.fn((key: string) => {
  const had = storage.has(key);
  const oldVal = had ? storage.get(key) : undefined;
  storage.delete(key);
  if (had) notifyValueListeners(key, oldVal, undefined);
});

const gmListValues = vi.fn(() => Array.from(storage.keys()));

const gmAddValueChangeListener = vi.fn((key: string, cb: ValueChangeCb) => {
  const id = nextListenerId++;
  valueListeners.set(id, { key, cb });
  return id;
});

const gmRemoveValueChangeListener = vi.fn((id: number) => {
  valueListeners.delete(id);
});

globalThis.GM_getValue = gmGetValue;
globalThis.GM_setValue = gmSetValue;
globalThis.GM_deleteValue = gmDeleteValue;
globalThis.GM_listValues = gmListValues;
globalThis.GM_addValueChangeListener = gmAddValueChangeListener;
globalThis.GM_removeValueChangeListener = gmRemoveValueChangeListener;
globalThis.GM_xmlhttpRequest = vi.fn();
globalThis.GM_registerMenuCommand = vi.fn();
globalThis.GM_download = vi.fn();

(globalThis as any).__MONKEY_WINDOW_KEY__ = 'unsafeWindow';
(globalThis as any).unsafeWindow = globalThis;

const cryptoObj = webcrypto;
Object.defineProperty(globalThis, 'crypto', {
  value: cryptoObj,
  writable: true,
  configurable: true
});

globalThis.Blob = NodeBlob as any;
globalThis.CompressionStream = CompressionStream as any;
globalThis.DecompressionStream = DecompressionStream as any;

if (typeof window !== 'undefined') {
  (window as any).GM_getValue = gmGetValue;
  (window as any).GM_setValue = gmSetValue;
  (window as any).GM_deleteValue = gmDeleteValue;
  (window as any).GM_listValues = gmListValues;
  (window as any).GM_addValueChangeListener = gmAddValueChangeListener;
  (window as any).GM_removeValueChangeListener = gmRemoveValueChangeListener;
  (window as any).unsafeWindow = window;
  (window as any).Blob = NodeBlob;
  (window as any).CompressionStream = CompressionStream;
  (window as any).DecompressionStream = DecompressionStream;

  Object.defineProperty(window, 'crypto', {
    value: cryptoObj,
    writable: true,
    configurable: true
  });

  if (typeof (globalThis as any).Response === 'undefined' && typeof (globalThis as any).Response !== 'undefined') {
    (window as any).Response = (globalThis as any).Response;
    (globalThis as any).Response = (globalThis as any).Response;
  }
}

beforeEach(() => {
  storage.clear();
  valueListeners.clear();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

const [{ configureCoreServices }, { AniList, MediaData }] = await Promise.all([
  import('../src/core/registry'),
  import('../src/api/anilist')
]);

configureCoreServices({
  api: {
    ...AniList,
    media: MediaData,
    session: {
      hasAuth: AniList.hasAuth,
      clear: AniList.clearViewer
    }
  },
  session: {
    hasAuth: AniList.hasAuth,
    clear: AniList.clearViewer
  }
});
