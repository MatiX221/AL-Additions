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
export type CssSource = string | (() => string);
export type MountStyleSource = string | ((selector: string) => string);

export interface DebouncedFn<T extends (...args: any[]) => void> {
  (...args: Parameters<T>): void;
  cancel: () => void;
  flush: () => void;
}

export interface PersistentCache<T = Record<string, any>> {
  data: T;
  save: () => void;
  cancel: () => void;
  flush: () => void;
}

export interface MountHandle<T extends Element = HTMLElement> {
  readonly id: string;
  readonly selector: string;
  el: () => T | null;
  readonly unmount: CleanupFn;
  readonly refresh: () => void;
}

export interface ModalOptions {
  id?: string;
  title: string;
  subtitle?: string;
  maxWidth?: string;
  style?: MountStyleSource;
  bodyHtml?: string;
  footerHtml?: string;
  onClose?: () => void;
}

export interface ModalHandle {
  readonly id: string;
  readonly selector: string;
  readonly signal: AbortSignal;
  backdrop: HTMLDivElement;
  sheet: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  close: () => void;
  listen: (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => CleanupFn;
  timeout: (fn: () => void, ms: number) => CleanupFn;
  onCleanup: (fn: CleanupFn) => void;
}

export interface ConfirmOptions {
  id?: string;
  title?: string;
  subtitle?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  maxWidth?: string;
  signal?: AbortSignal;
}

export interface AlertOptions {
  id?: string;
  title?: string;
  subtitle?: string;
  message: string;
  okText?: string;
  maxWidth?: string;
  signal?: AbortSignal;
}

export interface ToastOptions {
  type?: 'info' | 'success' | 'error';
  durationMs?: number;
  closeTab?: boolean;
}

export interface ToastApi {
  show: (msg: string, opts?: ToastOptions) => void;
  success: (msg: string, opts?: Omit<ToastOptions, 'type'>) => void;
  error: (msg: string, opts?: Omit<ToastOptions, 'type'>) => void;
}

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

export interface AddStyleFn {
  (css: CssSource): CleanupFn;
  (id: string, css: CssSource): CleanupFn;
}

export interface JsonEditorContext {
  value: any;
  onApply: (nextValue: any) => void;
  readonly signal: AbortSignal;
  getId: (name?: string) => string;
  addStyle: AddStyleFn;
  listen: (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => CleanupFn;
  timeout: (fn: () => void, ms: number) => CleanupFn;
  observe: (
    target: Node | null | undefined,
    options: MutationObserverInit,
    cb: MutationCallback
  ) => CleanupFn;
  modal: (opts: ModalOptions) => ModalHandle;
  confirm: (opts: string | ConfirmOptions) => Promise<boolean>;
  alert: (opts: string | AlertOptions) => Promise<void>;
  toast: ToastApi;
  onCleanup: (fn: CleanupFn) => void;
  api?: Omit<AniListClient, 'session'>;
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
  /** Auto-enable the parent module toggle in the Settings UI when a non-empty value is applied. */
  autoEnableParentWhenNonEmpty?: boolean;
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
  errors?: readonly { message?: string; [key: string]: any }[];
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
  markFetchOwner(active: boolean): CleanupFn;
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
  hasAuth: (opts?: { reconcile?: boolean }) => boolean;
  clear: () => void;
  syncFromPage?: () => void;
  peek: (opts?: { reconcile?: boolean }) => AniListSessionSnapshot;
  readonly userId: number | null;
  readonly username: string | null;
  readonly scoreFormat: string | null;
  recordHint: (hint: AniListViewerHint) => void;
}

export interface ViewerInfo {
  id: number;
  name: string;
  scoreFormat: string;
}

export interface MediaEntry {
  id: number;
  idMal: number | null;
  format: string;
  title: {
    userPreferred?: string;
    english?: string;
    romaji?: string;
    native?: string;
  };
  episodes: number | null;
  chapters: number | null;
  status: string;
  season?: string;
  seasonYear?: number;
  nextAiringEpisode?: {
    episode: number;
  };
  mediaListEntry?: {
    score: number;
    progress: number;
    status: string;
    completedAt?: {
      year?: number | null;
      month?: number | null;
      day?: number | null;
    } | null;
  };
}

export interface MediaListEntryItem {
  id: number;
  mediaId: number;
  status: string;
  score: number;
  progress: number;
  progressVolumes?: number;
  repeat?: number;
  priority?: number;
  notes?: string;
  customLists?: Record<string, boolean>;
  startedAt?: { year?: number; month?: number; day?: number };
  completedAt?: { year?: number; month?: number; day?: number };
  media?: {
    id: number;
    idMal: number | null;
    format?: string;
    episodes?: number | null;
    chapters?: number | null;
    status?: string;
    title?: {
      userPreferred?: string;
      english?: string;
      romaji?: string;
      native?: string;
    };
  };
}

export interface MediaListGroup {
  name: string;
  isCustomList: boolean;
  status: string | null;
  entries: MediaListEntryItem[];
}

export interface MediaListCollectionData {
  hasNextChunk?: boolean;
  user?: {
    id: number;
    name: string;
  };
  lists: MediaListGroup[];
}

export interface MediaListResult {
  collection: MediaListCollectionData;
  lists: MediaListGroup[];
  allEntries: MediaListEntryItem[];
  user?: { id: number; name: string };
}

export interface QueryOptions {
  retries?: number;
  forceFresh?: boolean;
  signal?: AbortSignal;
}

export interface AniListClient {
  query: <T = any>(
    q: string,
    variables?: Record<string, any>,
    optionsOrRetries?: number | QueryOptions
  ) => Promise<T>;
  getMediaList: (
    target: number | string,
    type?: 'ANIME' | 'MANGA',
    options?: { forceFresh?: boolean; userId?: number; userName?: string; signal?: AbortSignal }
  ) => Promise<MediaListResult>;
  viewer: (forceFresh?: boolean, opts?: { signal?: AbortSignal }) => Promise<ViewerInfo | null>;
  clearViewer: () => void;
  invalidate: (entityKeyPrefix?: string) => void;
  invalidateMediaList: (target?: number | string, type?: 'ANIME' | 'MANGA') => void;
  hasAuth: (opts?: { reconcile?: boolean }) => boolean;
  resumeAt: () => number;
  media: {
    get: (
      id: number | string,
      type: 'ANIME' | 'MANGA',
      opts?: { throwAuth?: boolean; signal?: AbortSignal }
    ) => Promise<MediaEntry | null>;
    save: (
      id: number | string,
      type: 'ANIME' | 'MANGA',
      patch: {
        score?: number;
        progress?: number;
        status?: string;
        completedAt?: { year: number; month: number; day: number };
      },
      opts?: { signal?: AbortSignal }
    ) => Promise<NonNullable<MediaEntry['mediaListEntry']> | null>;
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

export interface MountSpec<T extends Element = HTMLElement> {
  id?: string;
  anchor: string | (() => Element | null);
  position?: InsertPosition;
  create: () => T | null;
  match?: () => boolean;
  ownUi?: boolean;
  style?: MountStyleSource;
  onMount?: (el: T) => void | CleanupFn;
}

export interface HttpClient {
  request: (url: string, opts?: HttpRequestOptions) => Promise<any>;
  text: (url: string, opts?: HttpRequestOptions) => Promise<string>;
  json: <T = any>(url: string, opts?: HttpRequestOptions) => Promise<T>;
  download: (url: string, name: string, opts?: HttpDownloadOptions) => Promise<'download' | 'tab'>;
}

export interface RouteContext {
  url: URL;
  pathname: string;
  match: RegExpMatchArray | null;
  readonly signal: AbortSignal;
  getId: (name?: string) => string;
  onCleanup: (fn: CleanupFn) => void;
  ready: (cb: () => void) => CleanupFn;
  onBodyMutation: (cb: (mutations: MutationRecord[]) => void) => CleanupFn;
  observe: (
    target: Node | null | undefined,
    options: MutationObserverInit,
    cb: MutationCallback
  ) => CleanupFn;
  listen: (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => CleanupFn;
  interval: (fn: () => void, ms: number) => CleanupFn;
  timeout: (fn: () => void, ms: number) => CleanupFn;
  debounce: <T extends (...args: any[]) => void>(fn: T, ms?: number) => DebouncedFn<T>;
  raf: (fn: FrameRequestCallback) => CleanupFn;
  mount: <T extends Element = HTMLElement>(spec: MountSpec<T>) => MountHandle<T>;
  addStyle: AddStyleFn;
  modal: (opts: ModalOptions) => ModalHandle;
  confirm: (opts: string | ConfirmOptions) => Promise<boolean>;
  alert: (opts: string | AlertOptions) => Promise<void>;
  waitForSelector: <T extends HTMLElement = HTMLElement>(selector: string, timeoutMs?: number) => Promise<T | null>;
  http: HttpClient;
  api: Omit<AniListClient, 'session'>;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  data?: any;
  timeout?: number;
  responseType?: 'text' | 'json' | 'arraybuffer' | 'blob' | 'document' | 'stream';
  signal?: AbortSignal;
  [key: string]: any;
}

export interface HttpDownloadOptions {
  saveAs?: boolean;
  openTabOnError?: boolean;
  signal?: AbortSignal;
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
  readonly signal: AbortSignal;
  getId: (name?: string) => string;
  get: <T = any>(key: string) => T;
  set: (key: string, val: any) => void;
  storage: StorageScope;
  persistent: <T extends Record<string, any>>(key: string, prune?: (data: T) => void) => PersistentCache<T>;
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
  mount: <T extends Element = HTMLElement>(spec: MountSpec<T>) => MountHandle<T>;
  addStyle: AddStyleFn;
  modal: (opts: ModalOptions) => ModalHandle;
  confirm: (opts: string | ConfirmOptions) => Promise<boolean>;
  alert: (opts: string | AlertOptions) => Promise<void>;
  listen: (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => CleanupFn;
  interval: (fn: () => void, ms: number) => CleanupFn;
  timeout: (fn: () => void, ms: number) => CleanupFn;
  debounce: <T extends (...args: any[]) => void>(fn: T, ms?: number) => DebouncedFn<T>;
  raf: (fn: FrameRequestCallback) => CleanupFn;
  observe: (
    target: Node | null | undefined,
    options: MutationObserverInit,
    cb: MutationCallback
  ) => CleanupFn;
  trackEl: <T extends Element>(el: T) => T;
  waitForSelector: <T extends HTMLElement = HTMLElement>(selector: string, timeoutMs?: number) => Promise<T | null>;
  silently: (fn: () => void) => void;
  ownUi: (selector: string) => CleanupFn;
  onCleanup: (fn: CleanupFn) => void;
  http: HttpClient;
  api: Omit<AniListClient, 'session'>;
  session: AniListSession;
  accounts: FeatureAccounts<TAccountId>;
  toast: ToastApi;
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
