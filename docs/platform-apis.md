# Platform & Shared APIs

This guide covers everything modules share besides `ctx` itself: the AniList session and API client, connected accounts, core logging, and the helper code under `src/utils/` and `src/api/`.

Modules may import from `types.ts`, `utils/*`, `api/*`, and `core/registry.ts`. Anything that has a lifecycle-tracked version on `ctx` (including `ctx.getId`, `ctx.addStyle`, `ctx.mount`, `ctx.modal`, and `ctx.log`) must be used through `ctx` instead, see [Enforced Conventions](./architecture.md#enforced-conventions). For example, `core/contextScope.ts` and `core/modal.ts` are internal kernel code wrapped by [ctx.modal](./context-api.md#modals), `rc.modal`, and `JsonEditorContext`, not imported directly by modules.

---

## AniList Session

`ctx.session` answers one question: who is logged in to AniList right now. Never read the raw storage keys (`al_user_id`, `al_username`, `al_score_format`, `al_token_auth`, `al_token`), and never use `ctx.api.session`. Both are rejected by the convention tests.

| Member | Description |
| :--- | :--- |
| `peek(opts?)` | Returns `{ userId, username, scoreFormat }`, each possibly `null`. Pure read with no side effects, safe at `document-start`. Pass `{ reconcile: true }` to compare cached identity with the page first. |
| `userId`, `username`, `scoreFormat` | Live getters backed by `peek()`. |
| `hasAuth(opts?)` | `true` when the page shows a logged-in user. No network request. Pass `{ reconcile: false }` to perform a pure read without reconciling cached identity with the page. |
| `recordHint({ userId?, username? })` | Remember an identity you learned from an AniList response. Ignored on logged-out pages, when the hint contradicts the page, or during a session wipe. |
| `clear()` | Forget the stored identity and cached auth. |
| `syncFromPage()` | Drop stale identity if the user logged out or switched accounts. |

How `peek()` decides, in order:

1. If the navbar shows a login link, everything is `null`.
2. If the page's Nuxt state has a user, that id and name win. Stored values are only used when they match that user.
3. Otherwise the navbar username is used, with stored or cached values that match it.
4. Otherwise the last stored values are returned.

`hasAuth()` follows the same page evidence (login link, Nuxt user, navbar user, and finally a stored id plus name). It does not check whether a token is still valid. A rejected token shows up as an auth error from `ctx.api`, see below.

After a module is disposed, `clear`, `recordHint`, and `syncFromPage` do nothing, and both `peek({ reconcile: true })` and `hasAuth()` perform pure reads without reconciling or clearing session state.

---

## AniList API Client

`ctx.api`, `rc.api` (on [route contexts](./context-api.md#routing)), and `ec.api` (optional on [JSON editor contexts](./define-module.md#json-options)) expose a rate-limited, cached client for AniList's GraphQL endpoint typed as `Omit<AniListClient, 'session'>` (excluding `session` at compile time — use `ctx.session` instead). It posts to the page's own `/graphql` endpoint with the page's credentials, so there is nothing to configure. Shared query and DTO types (`QueryOptions`, `ViewerInfo`, `MediaEntry`, `MediaListEntryItem`, `MediaListGroup`, `MediaListCollectionData`, `MediaListResult`, `AniListClient`, `HttpClient`) live in `src/types.ts` (and are re-exported as types from `api/anilist`); never import runtime values from `api/anilist`.

### Scope-bound (`rc.api` / `ec.api`) vs module-scoped (`ctx.api`)

- **Use `rc.api` for route-scoped reads (and `ec.api` in JSON editors):** Inside `ctx.onRoute(...)`, `rc.api` binds `query`, `viewer`, `getMediaList`, and `media.get` (plus any rate-limiter waits and retries) to `rc.signal` (composed with any caller `signal`), so SPA navigation cancels stale route reads immediately. Likewise, `ec.api` in Settings JSON editors binds calls to `ec.signal` so closing the editor session or Settings panel aborts in-flight requests. After route/editor teardown (or module disposal), `clearViewer()`, `invalidate()`, and `invalidateMediaList()` do nothing, `hasAuth()` performs a pure read without reconciling (`reconcile: false`), and mutations (`media.save()` or GraphQL `mutation` calls via `query()`) reject with `Context disposed`.
- **Keep `ctx.api` for intentional route-surviving mutations and module-wide work:** Use `ctx.api` when a user-triggered mutation (such as `ctx.api.media.save(...)` for a score/progress edit) should still finish if the user navigates away right after clicking Save, or for cross-route shared flights coordinated explicitly with `SharedFlight` (`flightSignal`).

### Queries

```ts
const data = await ctx.api.query<{ Media: { id: number } }>(
  'query ($id: Int) { Media(id: $id) { id } }',
  { id: 16498 },
  { signal: rc.signal }
);
```

`query(text, variables?, optionsOrRetries?)` takes either a retry count or `QueryOptions` (`{ retries?: number; forceFresh?: boolean; signal?: AbortSignal }`). The default is 3 retries.

- **Retries:** network failures and HTTP 5xx are retried with a growing delay (1.5s per attempt, capped at 30s). HTTP 429 is retried after waiting.
- **Rate limiting:** requests pass through a token bucket that starts at 25 per minute and adapts to the limit AniList advertises. After a 429 every caller waits, in every tab. `ctx.api.resumeAt()` returns the time (ms since epoch) when requests resume, or `0`.
- **Auth failures:** an HTTP 401 or an "invalid token" style message clears the stored session and throws an error with `err.auth === 'AniList'`. Check `e?.auth`, not `e.auth === true`.
- **Mutations:** a query containing `mutation` is never cached and clears both cached entities and any FastLoad cache bridge when it starts and when it finishes.
- **Identical concurrent calls & waiter-isolated aborts:** concurrent calls share one underlying network flight, and `ctx.api` / `rc.api` / `ec.api` automatically compose the scope signal (`ctx.signal`, `rc.signal`, or `ec.signal`) with any caller `signal`. Each waiter tracks its own `AbortSignal`: aborting one caller rejects only that caller (`AbortError`) without aborting the shared flight for other live waiters; the underlying rate-limiter wait, retry backoff, and `fetch` abort only when the last live waiter aborts.
- **`forceFresh: true`** skips every cache and asks AniList directly.

### What gets cached

Simple queries on `Media` (scoped by `id` and `type`, or `*` when untyped; invalid or unresolvable explicit `type` values bypass caching), `MediaListCollection`, and `Viewer` are cached for 3 minutes by entity. A later query is served from cache when it asks only for fields a cached one already fetched. To benefit, keep the selection set plain: no aliases, no arguments on subfields, no directives. Anything more complex still works and is only de-duplicated while in flight. Variables that the query text does not use disable entity caching for that call.

### Helpers

| Method | Description |
| :--- | :--- |
| `viewer(forceFresh?, opts?)` | Returns `Promise<ViewerInfo \| null>` (`{ id, name, scoreFormat }`) for the logged-in user, or `null`. Reads stored values first, queries when they are missing. `opts` accepts `{ signal?: AbortSignal }`. |
| `hasAuth(opts?)` | Same as `ctx.session.hasAuth(opts)`. |
| `getMediaList(target, type?, options?)` | A user's full list (`Promise<MediaListResult>`). `target` is a positive user id or a username (overridden when explicit `options.userId` or `options.userName` is passed, which allows all-digit usernames), `type` defaults to `'ANIME'`, `options` is `{ forceFresh?, userId?, userName?, signal?: AbortSignal }`. Rejects on invalid/empty targets. Returns `{ collection, lists, allEntries, user }` with normalized `MediaListEntryItem` entries de-duplicated across custom lists. Scores are in the viewer's own score format. |
| `media.get(id, type, opts?)` | Core fields (`Promise<MediaEntry \| null>`) plus the viewer's list entry, or `null` on failure. `opts` accepts `{ throwAuth?: boolean; signal?: AbortSignal }`; pass `{ throwAuth: true }` to receive auth errors instead of `null`. |
| `media.save(id, type, patch, opts?)` | Save `{ score?, progress?, status?, completedAt? }` (with optional `opts?: { signal?: AbortSignal }`) and invalidate affected caches. Returns `Promise<NonNullable<MediaEntry['mediaListEntry']> \| null>`. |
| `invalidate(prefix?)` | Drop cached entities and clear any FastLoad cache bridge. When `prefix` is given, matches on `:` boundaries (for example `Media:16498` drops `Media:16498:ANIME`, `Media:16498:MANGA`, and `Media:16498:*` without affecting `Media:164980`). |
| `invalidateMediaList(target?, type?)` | Drop cached lists. Omitting `type` clears both `ANIME` and `MANGA` caches for `target`; omitting `target` clears all cached lists. |
| `clearViewer()` | Same effect as `session.clear()` plus a cache flush. |
| `resumeAt()` | See rate limiting above. |

`getMediaList` checks its entity cache (requiring all normalized `MediaListResult` fields to be present so partial `query()` results are bypassed) and any unfiltered, complete (`hasNextChunk !== true` and required `mediaId`, `media`, and `status` entry fields present) `MediaListCollection` entries in the caches that Fast Load fills (deduplicating identical pending worker prefetch flights across keys and falling back cleanly to `/graphql` on upstream prefetch aborts unless the caller's `signal` aborted) before querying the network. Treat the result as read-only.

After disposal (or after route/editor teardown for `rc.api` / `ec.api`), `clearViewer()`, `invalidate()`, and `invalidateMediaList()` do nothing, `media.save()` and GraphQL `mutation` calls via `query()` reject (`Context disposed`), non-mutation reads reject with `AbortError` because the scope `signal` (`ctx.signal`, `rc.signal`, or `ec.signal`) is aborted, and `hasAuth()` performs a pure read without reconciling.

Handling an auth failure:

```ts
try {
  await ctx.api.media.save(id, 'ANIME', { progress: 5 });
} catch (e: any) {
  if (e?.auth) ctx.toast.error('Log in to AniList first.');
  else ctx.log.error('Save failed:', e);
}
```

---

## Accounts

`ctx.accounts` reads and controls connected third-party accounts (currently MyAnimeList) without touching their token keys. A module must declare the providers it uses, see [Identity and Settings Card](./define-module.md#identity-and-settings-card):

```ts
defineModule({
  id: 'example',
  key: 'exampleEnabled',
  accounts: ['mal'],
  title: 'Example',
  help: '...',
  setup(ctx) {
    if (!ctx.accounts.isConnected('mal')) ctx.accounts.connect('mal');
  }
});
```

| Method | Description |
| :--- | :--- |
| `get(id)` | The provider object, or `undefined` when not registered. |
| `isConnected(id)` | Whether the provider reports a connection. |
| `connect(id)` | Start its authorization flow, usually by opening a tab. |
| `disconnect(id)` | Disconnect and clear its secrets. |
| `clearSecrets(id?)` | Clear secrets for one declared provider, or for every declared provider when called without an argument. |
| `watch(id, cb)` | Call `cb(connected)` only when the connection state flips. Works for providers registered before or after you subscribe. Returns a cleanup. |

Using an undeclared id is a type error, and at runtime throws `Module "<id>" cannot access account provider "<provider>" without declaring it in accounts`. `connect`, `disconnect`, and `clearSecrets` do nothing after disposal.

To add a new provider, see [Adding an Account Provider](./recipes.md#adding-an-account-provider).

---

## Core Logging

Files in `core/`, `settings/`, and `api/` log through `createCoreLogger` from `utils/helpers`, because they have no `ctx`. Modules must use `ctx.log` instead, see [Logging](./context-api.md#logging).

```ts
const log = createCoreLogger('anilist');
log.debug('cache hit', key);
log.warn('something odd');
```

The argument is one of four channels. Each has its own toggle under Advanced, then Developer Mode, then Core / Kernel Debug.

| Channel | Prefix | Covers |
| :--- | :--- | :--- |
| `core` | `[Core]` | Observer, routing, module lifecycle, event bus. |
| `settings` | `[Settings]` | Settings migrations, backups, restores. |
| `anilist` | `[AniList]` | The AniList API client and its caches. |
| `mal` | `[MAL]` | The MyAnimeList client and override refreshes. |

`warn` and `error` always print. `debug` prints only when Developer Mode and both the core master toggle and the channel toggle are on, or when `window.__ALA_DEBUG__` is set.

---

## Shared Utilities

### utils/helpers.ts

Safe to import in modules:

| Export | Description |
| :--- | :--- |
| `esc(value)` | HTML-escape `& < > " '` before interpolating text into `innerHTML`. |
| `clean(value)` | Collapse whitespace and trim. |
| `sleep(ms, signal?)` | Resolves after `ms` milliseconds (clamping finite positive delays to `0x7fffffff`), or rejects immediately with `AbortError` if `signal` aborts. |
| `debounce(fn, ms?)` | Trailing-edge debounce returning a `DebouncedFn<T>` callable with `.cancel()` and `.flush()`. (Inside modules, prefer `ctx.debounce` or `rc.debounce` so pending timers cancel on unload/route teardown.) |
| `composeAbortSignals(a, b?)` | Compose two optional `AbortSignal`s into `{ signal, dispose }`, aborting when either aborts (uses `AbortSignal.any` when available, otherwise forwards abort listeners until `dispose()`). |
| `createAbortError(signal?)` | Create a standard `AbortError` (`DOMException` or `Error`), preserving an `AbortError` `signal.reason` when present. |
| `isAbortError(err)` | Return `true` for `AbortError` exceptions as well as `HttpClient`'s `'Request aborted'` and `'Download aborted'` errors. |
| `raceWithSignal(promise, signal?, createAbort?)` | Race `promise` against an optional `AbortSignal`, suppressing unhandled rejections if `signal` aborts before `promise` settles. |
| `isGqlMutation(q)` | Return `true` when a GraphQL document contains a `mutation` operation outside comments and string literals. |
| `memo(fn, { keepNull?, ttl? })` | Cache an async function by key. Returns `(key, ...args) => Promise`, so the first argument is a cache key and the rest go to `fn`. Failed calls are not cached. `ttl` is in milliseconds, `0` means no expiry. |
| `safe(fn, label?)` | Run `fn`, log any throw, return `undefined` on failure. |
| `tryOr(asyncFn, fallback?)` | Await `asyncFn`, returning `fallback` (default `null`) on failure. |
| `authError(service, message)` | Create an error with `err.auth` set to the service name. |
| `parseToggle(value)` | `'false'` becomes `false`, otherwise truthiness. |
| `randomString(length)` | A random alphanumeric string from the Web Crypto API. |
| `openTab(url)` | Open a link in a new tab with `noopener`. |

Core only, rejected in modules by the convention tests: `store`, `jsonGet`, `jsonSet`, `persistent` (use `ctx.storage` and `ctx.persistent`), `gm`, `downloadFile` (use `ctx.http`), and `createLogger`, `isDebugEnabled`, `getDebuggableChannels`, `createCoreLogger` (use `ctx.log`).

### utils/dom.ts

- `icon(name, size?)` returns inline SVG markup. Names: `download`, `check`, `resync`, `stop`, `list`, `sliders`, `close`, `edit`, `external`, `chevron`. The default size is 18.
- `findExactText(text)` finds the outermost element whose whole text equals `text`. It returns `null` when `document.body` does not exist yet.

### utils/limiter.ts

`RateLimiter` is a token bucket measured in requests per minute. Use it for any external service you call.

```ts
const limiter = new RateLimiter({ rate: 60, min: 12, max: 180, burst: 4, adaptive: true, jitter: true, persistKey: 'my_resume_at' });

await limiter.acquire();                 // waits for a token
await limiter.acquire({ signal });       // aborts wait immediately if signal aborts
limiter.success();                       // adaptive: speeds up after 25 successes in a row
limiter.limit(60_000);                   // server said slow down: pause for a minute
```

| Option | Meaning |
| :--- | :--- |
| `rate` | Starting rate in requests per minute. |
| `min`, `max` | Bounds for the rate. Defaults are 1 and `rate`. |
| `burst` | Tokens available at once. Default 1. |
| `adaptive` | Halve the rate on `limit()`, raise it by about 10 percent after 25 successes. |
| `jitter` | Randomize cooldowns by roughly minus 10 to plus 20 percent. |
| `persistKey` | Share the cooldown across tabs through userscript storage. |

`acquire(checkOrOpts?: (() => void) | { check?: () => void; signal?: AbortSignal })` (`AcquireOptions`) accepts either a `check` callback or `{ check?, signal? }`. `check` runs on every wait (waits are chunked to at most 1 second, so cancellation, `setRate(n)`, and cooldown updates take effect promptly) and rejects if it throws; passing `signal` wakes any active `sleep` immediately on abort (via `sleep(ms, signal)` and `raceWithSignal`) without stalling the internal queue. `resumeAt` is the epoch time when a cooldown ends, or `0`. `setRate(n)` changes the rate within the bounds. A longer stored cooldown from another tab is never shortened by a shorter local one.

### utils/flight.ts

`createSharedFlight({ start, onEvict?, onSettled?, createAbortError? })` returns a waiter-isolated `SharedFlight<T>` (`{ controller, promise, waiters, settled, wait(opts?) }`), and `attachFlightWaiter(flight, { signal?, check? })` (also exposed as `flight.wait(opts?)`) attaches an independent waiter. Each waiter's `signal` and `check` only reject that individual waiter; the shared `controller` aborts (and `onEvict` runs synchronously) only when the last live waiter detaches before settlement, while unhandled rejections on abandoned flights are suppressed internally.

---

## Title Matching and Scrapers

Title helpers live next to the code that uses them.

| Export | File | Description |
| :--- | :--- | :--- |
| `strictTitle(s)` | `api/mal.ts` | Lowercase, NFKC-normalize, drop quotes, replace other punctuation with single spaces. Keeps articles. Use it for exact comparisons. |
| `normTitle(s)` | `api/scrapers.ts` | Like `strictTitle` but also removes the words `the`, `a`, `an`. |
| `titleScore(a, b)` | `api/scrapers.ts` | `0` to `100`. Exact normalized match is 100, whole-word containment scores 60 to 95, everything else is word overlap. |
| `bestMatch(list, title, getTitle, min?)` | `api/scrapers.ts` | The highest-scoring item at or above `min` (default 70), or `null`. |
| `parseLatest(value)` | `api/scrapers.ts` | Pull the highest chapter or episode number out of messy text, stripping thousands-separator commas while preserving comma-separated chapter lists. |
| `externalReleased(info, opts?)` | `api/scrapers.ts` | Latest released chapter count for a media object, looked up on MangaUpdates or NovelUpdates (skipping malformed or non-HTTP(S) links) and cached for 30 minutes using normalized or cleaned-lowercase title keys in `lookupCache`. Returns `null` when unknown or blank. |
| `mangaUpdates(title, opts?)`, `novelUpdates(title, opts?)` | `api/scrapers.ts` | Direct MangaUpdates / NovelUpdates chapter lookups paced by per-host `RateLimiter` instances (`muLimiter`, `nuLimiter`, 30 req/min, burst 3). |

`api/scrapers.ts` functions accept `ScraperOptions` (`{ http?: ScraperHttpClient; signal?: AbortSignal }`, where `ScraperHttpClient = Pick<HttpClient, 'text' | 'json'>`), defaulting `http` to the core `gm` helper when omitted. Modules should pass `{ http: ctx.http, signal: rc.signal }` (never `rc.http`) so requests share the module-scoped transport for `lookupCache` coalescing while still aborting cleanly on navigation or disposal. In-flight `lookupCache` coalescing is isolated by `(opts.http ?? gm)` transport identity and per-caller `signal` aborts—an aborted caller rejects immediately without cancelling or poisoning the cached flight for other live callers, and aborts the shared flight only when zero live waiters remain. All scraper hostnames must be present in `userscript.connect`.

---

## MyAnimeList API (`api/mal.ts`)

`src/api/mal.ts` provides the MyAnimeList v2 API client (`malUpdateEntry`, `malDeleteEntry`, `malWhoAmI`, `malFetchList`, `searchCandidates`, `searchMalId`, `malCall`), `malLimiter`, circuit breaker (`breaker`), and account provider registration.

- **Per-call cancellation (`MalCallOptions`):** `malUpdateEntry`, `malDeleteEntry`, `malWhoAmI`, `malFetchList`, `searchCandidates`, `searchMalId`, and `malCall` accept `opts?: MalCallOptions` (`{ checkCancel?: () => void; signal?: AbortSignal }`). Passing explicit `checkCancel` or `signal` isolates independent callers (such as background sync vs manual override audits) from the legacy global `hooks.checkCancel`, which is consulted only as a fallback when neither per-call option is supplied.
- **Waiter-isolated search deduplication:** `searchCandidates` shares in-flight candidate lookups across callers while tracking waiters per flight so one caller's `signal` abort only aborts the shared fetch when no live waiters remain.
- **Logging:** `api/mal.ts` routes logs through `createCoreLogger('mal')` (`[MAL]` prefix) and forwards UI log sinks set with `setMalUiSink(...)`.

---

## MyAnimeList Overrides

`api/malOverrides.ts` stores manual AniList to MyAnimeList mappings. A `malId` of `0` means "AniList only, never sync". The overrides only apply while the Manual Mappings feature is enabled.

| Export | Description |
| :--- | :--- |
| `getManualOverrides()` | All valid overrides, sanitized (non-HTTP(S) `cover` URLs are stripped). Corrupt entries are dropped. |
| `getOverride(mediaId)` | One override, or `undefined` (also when the feature is off). |
| `setOverride(mediaId, data)`, `removeOverride(mediaId)` | Write or delete one. Invalid ids and shapes are ignored. |
| `isIgnored(mediaId)` | `true` for an AniList-only override. |
| `getEffectiveMalId(mediaId, defaultMalId?)` | The id to use: the override if present, otherwise the default, otherwise `null`. |
| `validateOverrides(raw)`, `importOverrides(raw, mode)` | Validate or import a JSON object. `mode` is `'replace'` or `'merge'`. |
| `refreshStaleOverrides(opts?)` | Refresh titles, covers, and media types (`ANIME`/`MANGA`, preserving the existing type if omitted) older than 24 hours from AniList. Accepts `{ signal?: AbortSignal }` to abort between or during 50-item batches without writing partial aborted batches or logging abort warnings. |
