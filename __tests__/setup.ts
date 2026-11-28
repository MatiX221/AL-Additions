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

const gmGetValueImpl = (key: string, def?: any) => {
  return storage.has(key) ? storage.get(key) : def;
};

const gmSetValueImpl = (key: string, val: any) => {
  const oldVal = storage.has(key) ? storage.get(key) : undefined;
  storage.set(key, val);
  notifyValueListeners(key, oldVal, val);
};

const gmDeleteValueImpl = (key: string) => {
  const had = storage.has(key);
  const oldVal = had ? storage.get(key) : undefined;
  storage.delete(key);
  if (had) notifyValueListeners(key, oldVal, undefined);
};

const gmListValuesImpl = () => Array.from(storage.keys());

const gmAddValueChangeListenerImpl = (key: string, cb: ValueChangeCb) => {
  const id = nextListenerId++;
  valueListeners.set(id, { key, cb });
  return id;
};

const gmRemoveValueChangeListenerImpl = (id: number) => {
  valueListeners.delete(id);
};

const gmGetValue = vi.fn(gmGetValueImpl);
const gmSetValue = vi.fn(gmSetValueImpl);
const gmDeleteValue = vi.fn(gmDeleteValueImpl);
const gmListValues = vi.fn(gmListValuesImpl);
const gmAddValueChangeListener = vi.fn(gmAddValueChangeListenerImpl);
const gmRemoveValueChangeListener = vi.fn(gmRemoveValueChangeListenerImpl);
const gmXmlhttpRequest = vi.fn();
const gmRegisterMenuCommand = vi.fn();
const gmDownload = vi.fn();

globalThis.GM_getValue = gmGetValue;
globalThis.GM_setValue = gmSetValue;
globalThis.GM_deleteValue = gmDeleteValue;
globalThis.GM_listValues = gmListValues;
globalThis.GM_addValueChangeListener = gmAddValueChangeListener;
globalThis.GM_removeValueChangeListener = gmRemoveValueChangeListener;
globalThis.GM_xmlhttpRequest = gmXmlhttpRequest;
globalThis.GM_registerMenuCommand = gmRegisterMenuCommand;
globalThis.GM_download = gmDownload;

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
  (window as any).GM_xmlhttpRequest = gmXmlhttpRequest;
  (window as any).GM_registerMenuCommand = gmRegisterMenuCommand;
  (window as any).GM_download = gmDownload;
  (window as any).unsafeWindow = window;
  (window as any).Blob = NodeBlob;
  (window as any).CompressionStream = CompressionStream;
  (window as any).DecompressionStream = DecompressionStream;

  Object.defineProperty(window, 'crypto', {
    value: cryptoObj,
    writable: true,
    configurable: true
  });

  for (const name of ['Response', 'Headers', 'Request'] as const) {
    if (typeof (window as any)[name] === 'undefined' && typeof (globalThis as any)[name] !== 'undefined') {
      (window as any)[name] = (globalThis as any)[name];
    }
  }
}

const gmStubs: Array<{
  key:
    | 'GM_getValue'
    | 'GM_setValue'
    | 'GM_deleteValue'
    | 'GM_listValues'
    | 'GM_addValueChangeListener'
    | 'GM_removeValueChangeListener'
    | 'GM_xmlhttpRequest'
    | 'GM_registerMenuCommand'
    | 'GM_download';
  stub: ReturnType<typeof vi.fn>;
  defaultImpl?: (...args: any[]) => any;
}> = [
  { key: 'GM_getValue', stub: gmGetValue, defaultImpl: gmGetValueImpl },
  { key: 'GM_setValue', stub: gmSetValue, defaultImpl: gmSetValueImpl },
  { key: 'GM_deleteValue', stub: gmDeleteValue, defaultImpl: gmDeleteValueImpl },
  { key: 'GM_listValues', stub: gmListValues, defaultImpl: gmListValuesImpl },
  { key: 'GM_addValueChangeListener', stub: gmAddValueChangeListener, defaultImpl: gmAddValueChangeListenerImpl },
  { key: 'GM_removeValueChangeListener', stub: gmRemoveValueChangeListener, defaultImpl: gmRemoveValueChangeListenerImpl },
  { key: 'GM_xmlhttpRequest', stub: gmXmlhttpRequest },
  { key: 'GM_registerMenuCommand', stub: gmRegisterMenuCommand },
  { key: 'GM_download', stub: gmDownload }
];

beforeEach(() => {
  storage.clear();
  valueListeners.clear();
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
  }
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('style');

  for (const { key, stub, defaultImpl } of gmStubs) {
    if (typeof (globalThis as any)[key] !== 'function') {
      (globalThis as any)[key] = stub;
    }
    const activeGlobal = (globalThis as any)[key];
    if (typeof window !== 'undefined' && typeof (window as any)[key] !== 'function') {
      (window as any)[key] = activeGlobal;
    }
    if (typeof activeGlobal?.mockClear === 'function') {
      activeGlobal.mockClear();
    }
    if (typeof window !== 'undefined') {
      const activeWin = (window as any)[key];
      if (activeWin !== activeGlobal && typeof activeWin?.mockClear === 'function') {
        activeWin.mockClear();
      }
    }
    if (stub !== activeGlobal && typeof stub.mockClear === 'function') {
      stub.mockClear();
    }
    if (defaultImpl && typeof stub.getMockImplementation === 'function' && !stub.getMockImplementation()) {
      stub.mockImplementation(defaultImpl);
    }
  }
});

const [{ configureCoreServices }, { AniList, anilistApiClient }] = await Promise.all([
  import('../src/core/registry'),
  import('../src/api/anilist')
]);

configureCoreServices({
  api: anilistApiClient,
  session: AniList.session
});
