export const SETTING_PREFIX = 'ala_setting_';

export const ANILIST_SESSION_KEYS = [
  'al_token',
  'al_username',
  'al_user_id',
  'al_score_format',
  'al_token_auth'
] as const;

export const MEDIA_TYPES = ['ANIME', 'MANGA'] as const;
export type SyncMediaType = (typeof MEDIA_TYPES)[number];

export interface ManualOverride {
  malId: number;
  type: SyncMediaType;
  title: string;
  cover?: string;
  updatedAt: number;
}

export type ManualOverrideStore = Record<string, ManualOverride>;

export type CleanupFn = () => void;

export type SettingType = 'toggle' | 'number' | 'select' | 'list' | 'json';

export type ModuleLayer = 'intercept' | 'preload' | 'service' | 'feature' | 'shell';
export type FeatureLayer = Exclude<ModuleLayer, 'shell'>;

export interface LoggerMeta {
  readonly label: string;
  readonly title: string;
  readonly help?: string;
  readonly canDebug: boolean;
}

export type DebugMethod<TCanDebug extends boolean> = [TCanDebug] extends [false]
  ? (msg: never, ...args: never[]) => void
  : (...args: any[]) => void;

export interface Logger<TCanDebug extends boolean = false> extends LoggerMeta {
  readonly canDebug: TCanDebug;
  enabled: () => boolean;
  debug: DebugMethod<TCanDebug>;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export interface ChannelLogger<TCanDebug extends boolean = false> extends Logger<TCanDebug> {
  readonly id: string;
}

export type AnyLogger = Logger<true> | Logger<false>;

export interface JsonEditorContext {
  value: any;
  onApply: (nextValue: any) => void;
  addStyle: (id: string, css: string) => CleanupFn;
  listen: (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => CleanupFn;
  api?: AniListClient;
  log?: AnyLogger;
}

export interface SettingOption {
  key: string;
  type: SettingType;
  def: any;
  title: string;
  help: string;
  min?: number;
  max?: number;
  options?: [string, string][];
  legacy?: string[];
  validate?: (v: any) => any;
  childOf?: string;
  editor?: (ctx: JsonEditorContext) => void;
}

export interface SettingRow extends SettingOption {
  legacy: string[];
}

export interface DebugScopeState {
  enabled: boolean;
  channels?: Record<string, boolean>;
}

export type DebugSettingsMap = Record<string, DebugScopeState>;

export interface ModuleDebugChannelEnabledDef {
  label: string;
  title: string;
  help?: string;
  debug: true;
}

export interface ModuleDebugChannelDisabledDef {
  label: string;
  title?: string;
  help?: string;
  debug: false;
}

export type ModuleDebugChannelDef =
  | ModuleDebugChannelEnabledDef
  | ModuleDebugChannelDisabledDef;

export interface ModuleDebugEnabledDef<
  TChannels extends Record<string, ModuleDebugChannelDef> = Record<string, ModuleDebugChannelDef>
> {
  debug?: true;
  label?: string;
  title: string;
  help: string;
  channels?: TChannels;
}

export interface ModuleDebugDisabledDef<
  TChannels extends Record<string, ModuleDebugChannelDisabledDef> = Record<string, ModuleDebugChannelDisabledDef>
> {
  debug: false;
  label?: string;
  channels?: TChannels;
}

export type ModuleDebugDef<
  TChannels extends Record<string, ModuleDebugChannelDef> = Record<string, ModuleDebugChannelDef>
> =
  | ModuleDebugEnabledDef<TChannels>
  | ModuleDebugDisabledDef<Record<string, ModuleDebugChannelDisabledDef>>;

export type CanModuleDebug<TDebug> = [TDebug] extends [ModuleDebugEnabledDef<any>] ? true : false;

export type ModuleChannels<TDebug> = TDebug extends {
  readonly channels: infer C extends Record<string, ModuleDebugChannelDef>;
}
  ? C
  : {};

export interface ModuleLog<
  TCanDebug extends boolean = false,
  TChannels extends Record<string, ModuleDebugChannelDef> = {}
> extends Logger<TCanDebug> {
  channel: [keyof TChannels & string] extends [never]
    ? (id: never) => ChannelLogger<false>
    : <K extends keyof TChannels & string>(id: K) => ChannelLogger<TChannels[K]['debug']>;
}

export interface FeatureLogView<TCanDebug extends boolean = false> {
  readonly label: string;
  readonly title: string;
  readonly help?: string;
  readonly canDebug: boolean;
  enabled: () => boolean;
  debug: DebugMethod<TCanDebug>;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  channel: (id: never) => ChannelLogger<false> | ChannelLogger<true>;
}

export interface ModuleStandaloneDef {
  name: string;
  probe: () => boolean | Promise<boolean>;
  note?: string;
}

export interface MigrateContext {
  readonly id: string;
  storage: StorageScope;
  settings: {
    has: (key: string) => boolean;
    get: <T = any>(key: string) => T;
    set: (key: string, val: any) => void;
  };
  legacy: {
    get: <T = any>(key: string, def?: T) => T;
    set: <T = any>(key: string, val: T) => void;
    del: (key: string) => void;
    getLocal: (key: string) => string | null;
    delLocal: (key: string) => void;
  };
}

export interface FeatureMeta {
  id: string;
  key: string;
  section?: string;
  title: string;
  help: string;
  type?: SettingType;
  def?: any;
  legacy?: string[];
  options?: SettingOption[];
  hosts?: string[];
  layer?: FeatureLayer;
  requiresReload?: boolean;
  dependsOn?: string[];
  after?: string[];
  accounts?: readonly string[];
  debug?: ModuleDebugDef;
  standalone?: ModuleStandaloneDef;
}

export interface EventMap {}
export interface ServiceMap {}

export type EventArgs<P> = [P] extends [void] ? [] : undefined extends P ? [payload?: P] : [payload: P];

export type LocalServices<TId extends string> = {
  [K in keyof ServiceMap as K extends `${TId}:${infer Local}` ? Local : never]: ServiceMap[K];
};

export interface ModuleMeta<
  TId extends string = string,
  TDebug extends ModuleDebugDef<any> | undefined = undefined,
  TAccounts extends readonly string[] = readonly []
> {
  id: TId;
  key: string;
  legacy?: string[];
  section?: string;
  title: string;
  help: string;
  options?: SettingOption[];
  hosts?: string[];
  layer?: FeatureLayer;
  requiresReload?: boolean;
  dependsOn?: string[];
  after?: string[];
  accounts?: TAccounts;
  debug?: TDebug;
  standalone?: ModuleStandaloneDef;
  migrate?: (m: MigrateContext) => void;
  setup: (
    ctx: ScopedFeatureContext<TId, CanModuleDebug<TDebug>, ModuleChannels<TDebug>, TAccounts[number]>
  ) => void | Promise<void>;
}

export interface RegisteredFeature {
  id: string;
  section: string;
  title: string;
  help: string;
  toggle: SettingRow;
  options: SettingRow[];
  layer?: ModuleLayer;
  hosts?: string[];
  requiresReload?: boolean;
  dependsOn?: string[];
  after?: string[];
  accounts?: readonly string[];
  debug?: ModuleDebugDef;
  standalone?: ModuleStandaloneDef;
}

export type ModuleDisableReason =
  | 'disabled'
  | 'dep-off'
  | 'dep-unavailable'
  | 'cycle'
  | 'layer-conflict'
  | 'id-collision'
  | 'invalid-id'
  | 'standalone-paused'
  | 'host-mismatch'
  | 'error';

export interface ModuleStatus {
  active: boolean;
  reason?: ModuleDisableReason;
  error?: string;
  missingDeps?: string[];
  disabledDeps?: string[];
}

export interface ModuleHost {
  readonly api?: AniListClient;
  reload(ids: string[]): void;
  getStatus(id: string): ModuleStatus;
  resolveStagedStates(stagedEnabled: Record<string, boolean>): Record<string, ModuleStatus>;
  onStatusChange(cb: (id: string, status: ModuleStatus) => void): () => void;
  probeStandalone(id: string): Promise<boolean>;
}

export interface AccountProvider {
  id: string;
  name: string;
  secretKeys: readonly string[];
  isConnected: () => boolean;
  connect: () => void;
  disconnect: () => void;
  onAuthCallback?: () => void | Promise<void>;
}

export interface GqlFetchEvent {
  phase: 'request' | 'response';
  url: string;
  query: string;
  variables: Record<string, any>;
  operationName?: string;
  status?: number;
  ok?: boolean;
  data?: any;
}

export type GqlFetchListener = (event: GqlFetchEvent) => void;
export type RpcBlocker = (query: string, variables: Record<string, any>) => boolean;

export interface FastLoadCacheBridge {
  getGqlStore: () => Map<string, any> | undefined;
  getRpcCache: () => Map<string, any> | undefined;
  getRpcInflight: () => Map<string, any> | undefined;
  getUserMap: () => Map<string, number> | undefined;
  getIdMap: () => Map<number, string> | undefined;
  clear: () => void;
  clearAuth: () => void;
}

export interface CoreHooksApi {
  setSessionClearing(active: boolean): void;
  isSessionClearing(): boolean;
  getAuthHeader(): string | null;
  setAuthHeader(header: string | null): void;
  clearAuth(): void;
  registerCacheBridge(bridge: FastLoadCacheBridge): CleanupFn;
  getCacheBridge(): FastLoadCacheBridge | null;
  markFetchOwner(active: boolean): void;
  hasGqlFetchSubscribers(): boolean;
  emitGqlFetch(event: GqlFetchEvent): void;
  onGqlFetch(cb: GqlFetchListener): CleanupFn;
  blockRpc(fn: RpcBlocker): CleanupFn;
  isRpcBlocked(query: string, variables: Record<string, any>): boolean;
  setPrefetchPaused(paused: boolean): CleanupFn;
  isPrefetchSuppressed(): boolean;
}

export interface AniListSessionSnapshot {
  userId: number | null;
  username: string | null;
  scoreFormat: string | null;
}

export interface AniListViewerHint {
  userId?: number | null;
  username?: string | null;
}

export interface AniListSession {
  hasAuth: () => boolean;
  clear: () => void;
  syncFromPage?: () => void;
  peek: (opts?: { reconcile?: boolean }) => AniListSessionSnapshot;
  readonly userId: number | null;
  readonly username: string | null;
  readonly scoreFormat: string | null;
  recordHint: (hint: AniListViewerHint) => void;
}

export interface AniListClient {
  query: <T = any>(q: string, variables?: Record<string, any>, optionsOrRetries?: number | any) => Promise<T>;
  getMediaList: (target: number | string, type?: 'ANIME' | 'MANGA', options?: any) => Promise<any>;
  viewer: (forceFresh?: boolean) => Promise<any>;
  clearViewer: () => void;
  invalidate: (entityKeyPrefix?: string) => void;
  invalidateMediaList: (target?: number | string, type?: 'ANIME' | 'MANGA') => void;
  hasAuth: () => boolean;
  resumeAt: () => number;
  media: {
    get: (id: number | string, type: 'ANIME' | 'MANGA', opts?: { throwAuth?: boolean }) => Promise<any>;
    save: (
      id: number | string,
      type: 'ANIME' | 'MANGA',
      patch: {
        score?: number;
        progress?: number;
        status?: string;
        completedAt?: { year: number; month: number; day: number };
      }
    ) => Promise<any>;
  };
  session: AniListSession;
}

export interface StorageScope {
  get: <T>(key: string, def?: T) => T;
  set: <T>(key: string, val: T) => void;
  del: (key: string) => void;
  watch: (key: string, cb: (key: string, oldVal: any, newVal: any, remote: boolean) => void) => CleanupFn;
  clear: () => void;
}

export interface MountSpec {
  id?: string;
  anchor: string | (() => Element | null);
  position?: InsertPosition;
  create: () => HTMLElement;
  match?: () => boolean;
  ownUi?: boolean;
}

export interface RouteContext {
  url: URL;
  pathname: string;
  match: RegExpMatchArray | null;
  signal: AbortSignal;
  onCleanup: (fn: CleanupFn) => void;
  listen: (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => CleanupFn;
  interval: (fn: () => void, ms: number) => CleanupFn;
  timeout: (fn: () => void, ms: number) => CleanupFn;
  mount: (spec: MountSpec) => CleanupFn;
  waitForSelector: <T extends HTMLElement = HTMLElement>(selector: string, timeoutMs?: number) => Promise<T | null>;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  data?: any;
  timeout?: number;
  responseType?: 'text' | 'json' | 'arraybuffer' | 'blob' | 'document' | 'stream';
  [key: string]: any;
}

export interface HttpDownloadOptions {
  saveAs?: boolean;
  openTabOnError?: boolean;
}

export interface FeatureServices {
  provide(localName: never, impl: never): CleanupFn;
  get<K extends keyof ServiceMap>(fullName: K): ServiceMap[K] | undefined;
  onAvailable<K extends keyof ServiceMap>(fullName: K, cb: (impl: ServiceMap[K]) => void | CleanupFn): CleanupFn;
}

export interface FeatureEvents {
  emit<K extends keyof EventMap>(event: K, ...args: EventArgs<EventMap[K]>): void;
  emitRetained<K extends keyof EventMap>(event: K, ...args: EventArgs<EventMap[K]>): void;
  on<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): CleanupFn;
  onRetained<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): CleanupFn;
}

export interface FeatureAccounts<TAccountId extends string = never> {
  get: (id: TAccountId) => AccountProvider | undefined;
  isConnected: (id: TAccountId) => boolean;
  connect: (id: TAccountId) => void;
  disconnect: (id: TAccountId) => void;
  clearSecrets: (providerId?: TAccountId) => void;
  watch: (id: TAccountId, cb: (connected: boolean) => void) => CleanupFn;
}

export interface FeatureContext<
  TCanDebug extends boolean = false,
  TAccountId extends string = never
> {
  readonly id: string;
  readonly title: string;
  readonly help: string;
  get: <T = any>(key: string) => T;
  set: (key: string, val: any) => void;
  storage: StorageScope;
  persistent: <T extends Record<string, any>>(key: string, prune?: (data: T) => void) => { data: T; save: () => void };
  ready: (cb: () => void) => CleanupFn;
  onNav: (cb: () => void) => CleanupFn;
  onBodyMutation: (cb: (mutations: MutationRecord[]) => void) => CleanupFn;
  onRoute: {
    (handler: (rc: RouteContext) => void | Promise<void> | CleanupFn): CleanupFn;
    (
      match: RegExp | ((url: URL) => boolean),
      handler: (rc: RouteContext) => void | Promise<void> | CleanupFn
    ): CleanupFn;
  };
  mount: (spec: MountSpec) => CleanupFn;
  addStyle: (id: string, css: string) => CleanupFn;
  listen: (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => CleanupFn;
  interval: (fn: () => void, ms: number) => CleanupFn;
  timeout: (fn: () => void, ms: number) => CleanupFn;
  trackEl: <T extends Element>(el: T) => T;
  waitForSelector: <T extends HTMLElement = HTMLElement>(selector: string, timeoutMs?: number) => Promise<T | null>;
  silently: (fn: () => void) => void;
  ownUi: (selector: string) => CleanupFn;
  onCleanup: (fn: CleanupFn) => void;
  http: {
    request: (url: string, opts?: HttpRequestOptions) => Promise<any>;
    text: (url: string, opts?: HttpRequestOptions) => Promise<string>;
    json: <T = any>(url: string, opts?: HttpRequestOptions) => Promise<T>;
    download: (url: string, name: string, opts?: HttpDownloadOptions) => Promise<'download' | 'tab'>;
  };
  api: AniListClient;
  session: AniListSession;
  accounts: FeatureAccounts<TAccountId>;
  toast: {
    show: (msg: string, opts?: { type?: 'info' | 'success' | 'error'; durationMs?: number; closeTab?: boolean }) => void;
    success: (msg: string, opts?: { durationMs?: number; closeTab?: boolean }) => void;
    error: (msg: string, opts?: { durationMs?: number; closeTab?: boolean }) => void;
  };
  menuCommand: (label: string, onClick: () => void) => CleanupFn;
  services: FeatureServices;
  events: FeatureEvents;
  hooks: CoreHooksApi;
  log: FeatureLogView<TCanDebug>;
  setStandalonePaused: (paused: boolean) => void;
}

export interface ScopedFeatureContext<
  TId extends string,
  TCanDebug extends boolean = false,
  TChannels extends Record<string, ModuleDebugChannelDef> = {},
  TAccountId extends string = never
> extends Omit<FeatureContext<TCanDebug, TAccountId>, 'id' | 'log' | 'services'> {
  readonly id: TId;
  services: {
    provide<K extends keyof LocalServices<TId>>(localName: K, impl: LocalServices<TId>[K]): CleanupFn;
    get<K extends keyof ServiceMap>(fullName: K): ServiceMap[K] | undefined;
    onAvailable<K extends keyof ServiceMap>(fullName: K, cb: (impl: ServiceMap[K]) => void | CleanupFn): CleanupFn;
  };
  log: ModuleLog<TCanDebug, TChannels>;
}

export interface MediaRoute {
  kind: 'anime' | 'manga';
  type: 'ANIME' | 'MANGA';
  id: number;
}

export interface ModuleDef {
  name: string;
  setting: string | null;
  init: () => void | Promise<void>;
  hosts: string[];
  early: boolean;
  layer: ModuleLayer;
  dependsOn: string[];
  after: string[];
}
