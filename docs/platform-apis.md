# Platform & Shared APIs

This guide covers everything modules share besides `ctx` itself: the AniList session and API client, connected accounts, core logging, and the helper code under `src/utils/` and `src/api/`.

Modules may import from `types.ts`, `utils/*`, `api/*`, and `core/registry.ts`. Anything that has a lifecycle-tracked version on `ctx` must be used through `ctx` instead, see [Enforced Conventions](./architecture.md#enforced-conventions).

---

## AniList Session

`ctx.session` answers one question: who is logged in to AniList right now. Never read the raw storage keys (`al_user_id`, `al_username`, `al_score_format`, `al_token_auth`, `al_token`), and never use `ctx.api.session`. Both are rejected by the convention tests.

| Member | Description |
| :--- | :--- |
| `peek(opts?)` | Returns `{ userId, username, scoreFormat }`, each possibly `null`. Pure read with no side effects, safe at `document-start`. Pass `{ reconcile: true }` to compare cached identity with the page first. |
| `userId`, `username`, `scoreFormat` | Live getters backed by `peek()`. |
| `hasAuth()` | `true` when the page shows a logged-in user. No network request. |
| `recordHint({ userId?, username? })` | Remember an identity you learned from an AniList response. Ignored on logged-out pages, when the hint contradicts the page, or during a session wipe. |
| `clear()` | Forget the stored identity and cached auth. |
| `syncFromPage()` | Drop stale identity if the user logged out or switched accounts. |

How `peek()` decides, in order:

1. If the navbar shows a login link, everything is `null`.
2. If the page's Nuxt state has a user, that id and name win. Stored values are only used when they match that user.
3. Otherwise the navbar username is used, with stored or cached values that match it.
4. Otherwise the last stored values are returned.

`hasAuth()` follows the same page evidence (login link, Nuxt user, navbar user, and finally a stored id plus name). It does not check whether a token is still valid. A rejected token shows up as an auth error from `ctx.api`, see below.

After a module is disposed, `clear`, `recordHint`, and `syncFromPage` do nothing and `peek({ reconcile: true })` is downgraded to a plain read.

---

## AniList API Client

`ctx.api` is a rate-limited, cached client for AniList's GraphQL endpoint. It posts to the page's own `/graphql` endpoint with the page's credentials, so there is nothing to configure. Do not import the `AniList` singleton from `api/anilist`. Importing types from that file is fine.

### Queries

```ts
const data = await ctx.api.query<{ Media: { id: number } }>(
  'query ($id: Int) { Media(id: $id) { id } }',
  { id: 16498 }
);
```

`query(text, variables?, optionsOrRetries?)` takes either a retry count or `{ retries, forceFresh }`. The default is 3 retries.

- **Retries:** network failures and HTTP 5xx are retried with a growing delay. HTTP 429 is retried after waiting.
- **Rate limiting:** requests pass through a token bucket that starts at 25 per minute and adapts to the limit AniList advertises. After a 429 every caller waits, in every tab. `ctx.api.resumeAt()` returns the time (ms since epoch) when requests resume, or `0`.
- **Auth failures:** an HTTP 401 or an "invalid token" style message clears the stored session and throws an error with `err.auth === 'AniList'`. Check `e?.auth`, not `e.auth === true`.
- **Mutations:** a query containing `mutation` is never cached and invalidates every cached entity when it finishes.
- **Identical concurrent calls** share one network request.
- **`forceFresh: true`** skips every cache and asks AniList directly.

### What gets cached

Simple queries on `Media`, `MediaListCollection`, and `Viewer` are cached for 3 minutes by entity. A later query is served from cache when it asks only for fields a cached one already fetched. To benefit, keep the selection set plain: no aliases, no arguments on subfields, no directives. Anything more complex still works and is only de-duplicated while in flight. Variables that the query text does not use disable entity caching for that call.

### Helpers

| Method | Description |
| :--- | :--- |
| `viewer(forceFresh?)` | `{ id, name, scoreFormat }` for the logged-in user, or `null`. Reads stored values first, queries when they are missing. |
| `hasAuth()` | Same as `ctx.session.hasAuth()`. |
| `getMediaList(target, type?, options?)` | A user's full list. `target` is a user id or a username, `type` defaults to `'ANIME'`, `options` is `{ forceFresh, userId, userName }`. Returns `{ collection, lists, allEntries, user }` with entries de-duplicated across custom lists. Scores are in the viewer's own score format. |
| `media.get(id, type, opts?)` | Core fields plus the viewer's list entry, or `null` on failure. Pass `{ throwAuth: true }` to receive auth errors instead of `null`. |
| `media.save(id, type, patch)` | Save `{ score?, progress?, status?, completedAt? }` and invalidate affected caches. Returns the saved entry. |
| `invalidate(prefix?)` | Drop cached entities, optionally only keys starting with a prefix such as `Media:16498`. |
| `invalidateMediaList(target?, type?)` | Drop cached lists. |
| `clearViewer()` | Same effect as `session.clear()` plus a cache flush. |
| `resumeAt()` | See rate limiting above. |

`getMediaList` first looks in the caches that the Fast Load feature fills, then in its own cache, and only then asks the network. Treat the result as read-only.

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

Using an undeclared id is a type error, and at runtime throws `Module "<id>" cannot access account provider "<provider>" without declaring it in accounts`. `connect` and `disconnect` do nothing after disposal.

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
| `sleep(ms)` | A promise that resolves after a delay. |
| `debounce(fn, ms?)` | Trailing-edge debounce. |
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

await limiter.acquire();           // waits for a token
limiter.success();                 // adaptive: speeds up after 25 successes in a row
limiter.limit(60_000);             // server said slow down: pause for a minute
```

| Option | Meaning |
| :--- | :--- |
| `rate` | Starting rate in requests per minute. |
| `min`, `max` | Bounds for the rate. Defaults are 1 and `rate`. |
| `burst` | Tokens available at once. Default 1. |
| `adaptive` | Halve the rate on `limit()`, raise it by about 10 percent after 25 successes. |
| `jitter` | Randomize cooldowns by roughly minus 10 to plus 20 percent. |
| `persistKey` | Share the cooldown across tabs through userscript storage. |

`acquire(check?)` calls `check` on every wait and rejects if it throws, which is how cancellation works. `resumeAt` is the epoch time when a cooldown ends, or `0`. `setRate(n)` changes the rate within the bounds. A longer stored cooldown from another tab is never shortened by a shorter local one.

---

## Title Matching and Scrapers

Title helpers live next to the code that uses them.

| Export | File | Description |
| :--- | :--- | :--- |
| `strictTitle(s)` | `api/mal.ts` | Lowercase, NFKC-normalize, drop quotes, replace other punctuation with single spaces. Keeps articles. Use it for exact comparisons. |
| `normTitle(s)` | `api/scrapers.ts` | Like `strictTitle` but also removes the words `the`, `a`, `an`. |
| `titleScore(a, b)` | `api/scrapers.ts` | `0` to `100`. Exact normalized match is 100, whole-word containment scores 60 to 95, everything else is word overlap. |
| `bestMatch(list, title, getTitle, min?)` | `api/scrapers.ts` | The highest-scoring item at or above `min` (default 70), or `null`. |
| `parseLatest(value)` | `api/scrapers.ts` | Pull the highest chapter or episode number out of messy text. |
| `externalReleased(info)` | `api/scrapers.ts` | Latest released chapter count for a media object, looked up on MangaUpdates or NovelUpdates and cached for 30 minutes. Returns `null` when unknown. |

`api/scrapers.ts` calls its hosts through `ctx`-independent request helpers, so the hostnames must be present in `userscript.connect`.

---

## MyAnimeList Overrides

`api/malOverrides.ts` stores manual AniList to MyAnimeList mappings. A `malId` of `0` means "AniList only, never sync". The overrides only apply while the Manual Mappings feature is enabled.

| Export | Description |
| :--- | :--- |
| `getManualOverrides()` | All valid overrides, sanitized. Corrupt entries are dropped. |
| `getOverride(mediaId)` | One override, or `undefined` (also when the feature is off). |
| `setOverride(mediaId, data)`, `removeOverride(mediaId)` | Write or delete one. Invalid ids and shapes are ignored. |
| `isIgnored(mediaId)` | `true` for an AniList-only override. |
| `getEffectiveMalId(mediaId, defaultMalId?)` | The id to use: the override if present, otherwise the default, otherwise `null`. |
| `validateOverrides(raw)`, `importOverrides(raw, mode)` | Validate or import a JSON object. `mode` is `'replace'` or `'merge'`. |
| `refreshStaleOverrides()` | Refresh titles and covers older than 24 hours from AniList. |
