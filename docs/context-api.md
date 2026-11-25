# Context API

Every active module receives its own `ctx` (a `FeatureContext`) in `setup(ctx)`. Anything you create through `ctx` is tracked and removed when the module is disabled, hot-reloaded, or fails. After disposal, lifecycle registrations, DOM mounts, timers, listeners, HTTP requests, storage writes, account connection changes, and event or hook mutations stop or abort, so a late timer or promise cannot revive a dead module.

This reference covers the runtime API. Related members live elsewhere:

| Member | Where it is documented |
| :--- | :--- |
| `ctx.session`, `ctx.api` | [AniList Session](./platform-apis.md#anilist-session) and [AniList API Client](./platform-apis.md#anilist-api-client) |
| `ctx.accounts` | [Accounts](./platform-apis.md#accounts). Limited to providers declared in [accounts](./define-module.md#identity-and-settings-card). |
| `ctx.services`, `ctx.events`, `ctx.hooks` | [Services](./communication.md#services), [Events](./communication.md#events), [Hooks](./communication.md#hooks) |
| `ctx.setStandalonePaused` | [Standalone Conflict Yielding](./define-module.md#standalone-conflict-yielding) |
| `ctx.id`, `ctx.title`, `ctx.help` | Read-only copies of the values from [defineModule](./define-module.md#identity-and-settings-card) |

---

## Settings Access

```ts
const interval = ctx.get<number>('exampleInterval');
ctx.set('exampleInterval', 12);
```

- `ctx.get(key)` returns the normalized value of any registered setting. Unknown keys throw `Unknown setting: <key>`.
- `ctx.set(key, value)` normalizes and saves a value. It does not reload any module. Use it to remember a user choice made outside the Settings panel.

Modules cannot import `Settings` or call `Settings.get/set/has/register/migrate`. The convention tests reject both. Code in other files of your module receives values as arguments instead, see [Using ctx From Sibling Files](#using-ctx-from-sibling-files). Options are declared in [Child Options](./define-module.md#child-options).

---

## Storage

`ctx.storage` is a key-value store scoped to your module. Keys are saved under `ala_mod_<id>_<key>` in userscript storage, which is shared across tabs.

| Method | Description |
| :--- | :--- |
| `get<T>(key, default?)` | Read a value, or the default when missing. |
| `set(key, value)` | Save any structured-cloneable value. |
| `del(key)` | Remove a key. |
| `watch(key, cb)` | Call `cb(key, oldValue, newValue, remote)` on change. `remote` is `true` when another tab wrote it. Returns a cleanup. |
| `clear()` | Delete every key in your scope, including [persistent caches](#persistent-caches). |

After disposal `set` and `del` do nothing, and callbacks from `watch` stop firing. `clear()` still works, which is what a "Reset all data" menu command needs.

Never hardcode the `ala_mod_` prefix, and never use `localStorage`, `sessionStorage`, or the `store` helper from `utils/helpers`. All three are rejected by the convention tests. See [Enforced Conventions](./architecture.md#enforced-conventions). Migrations read old raw keys through `m.legacy`, see [Migrations](./define-module.md#migrations).

### Persistent Caches

For a larger object that you mutate often, use `ctx.persistent`:

```ts
const cache = ctx.persistent<Record<string, { value: number; expires: number }>>(
  'cache_v1',
  (data) => {
    for (const id of Object.keys(data)) {
      if (!(data[id].expires > Date.now())) delete data[id];
    }
  }
);

cache.data['16498'] = { value: 1, expires: Date.now() + 3600e3 };
cache.save();
```

- `data` loads lazily on first access, and the optional prune function runs once right after loading.
- Mutate `data` in place, then call `save()`. Saves are debounced by 500 ms.
- The key is scoped to your module exactly like `ctx.storage`: it is stored as `ala_mod_<id>_<key>`, so a short name is enough and it cannot collide with another module. `ctx.storage.clear()` deletes it from storage. The object you already loaded stays in memory, and the next `save()` writes it again.
- Include a version suffix in the key. When the shape changes, use a new suffix and delete the old key in a [migration](./define-module.md#migrations). Keys written by older script versions without the module prefix are removed with `m.legacy.del(oldKey)`.
- Data stays after the module is disabled. Use a prune function or expiry timestamps to keep it from growing.

Use `ctx.storage` for small settings-like values and `ctx.persistent` for caches. Never import `persistent` from `utils/helpers` in a module.

---

## Lifecycle and Cleanup

| Method | Description |
| :--- | :--- |
| `ctx.onCleanup(fn)` | Run `fn` when the module unloads. Use it for anything you created without `ctx`. |
| `ctx.trackEl(el)` | Remove `el` when the module unloads. Returns the element. |
| `ctx.ready(cb)` | Run `cb` once `document.body` exists, immediately if it already does. |
| `ctx.onNav(cb)` | Run `cb` whenever the URL changes. |
| `ctx.onBodyMutation(cb)` | Run `cb(mutations)` for batched DOM changes. |
| `ctx.waitForSelector(sel, timeoutMs?)` | Resolve with the element, or `null` on timeout (default 8000 ms) or unload. |

Cleanups run in reverse order of registration. A cleanup that throws is logged and does not stop the others.

**Navigation detection** fires when `location.href` changes. The kernel patches `history.pushState` and `replaceState` and listens to `popstate` and `hashchange`, with a 400 ms poll as a safety net. Hash-only changes count. Prefer [ctx.onRoute](#routing) for page-specific work, because it also handles teardown.

**Body mutations** are collected for 50 ms and delivered in one batch. Mutations inside [own UI](#observer-exclusions) are filtered out. The observer is shared by all modules, so keep the callback fast and debounce expensive work.

---

## Routing

`ctx.onRoute` runs a handler for matching URLs and tears it down when the URL stops matching or changes.

```ts
ctx.onRoute(handler);                                     // every URL
ctx.onRoute(/^\/anime\/(\d+)/, handler);                  // RegExp tested against the pathname
ctx.onRoute((url) => url.searchParams.has('q'), handler); // custom matcher
```

The handler runs at registration and again on every navigation. Before each run the previous run is torn down, even when the new URL matches the same pattern, so expect to remount when moving from `/anime/1` to `/anime/1/characters`. A matcher that throws is logged and treated as no match.

The handler receives a route context `rc`:

| Member | Description |
| :--- | :--- |
| `rc.url`, `rc.pathname` | The current URL and its path. |
| `rc.match` | The `RegExp` match array, or `null` for function matchers and no matcher. |
| `rc.signal` | An `AbortSignal` that aborts at teardown. Pass it to async work. |
| `rc.onCleanup(fn)` | Run `fn` at teardown (immediately if already torn down). |
| `rc.listen`, `rc.interval`, `rc.timeout` | Same as the `ctx` versions, scoped to this route run. |
| `rc.mount(spec)` | [Mount](#mounting-dom-elements) an element for this route run. |
| `rc.waitForSelector(sel, ms?)` | Like `ctx.waitForSelector`, also resolves `null` at teardown. |

A handler may return a cleanup function or a promise of one. For async handlers, always re-check `rc.signal.aborted` after an `await`. Mounts and listeners created after teardown are ignored automatically, but your own state changes are not:

```ts
ctx.onRoute(/^\/anime\/(\d+)/, async (rc) => {
  const data = await ctx.api.media.get(Number(rc.match![1]), 'ANIME');
  if (rc.signal.aborted) return;
  // safe to use data
});
```

### Route Patterns

The kernel has no shared route-parser module. Each module declares the pattern it needs. These cover the common AniList pages. All are matched against the pathname only.

| Page | Pattern | Capture groups |
| :--- | :--- | :--- |
| Anime or manga page | `/^\/(anime\|manga)\/(\d+)(?:\/\|$)/` | 1: kind, 2: media id |
| Staff or studio page | `/^\/(staff\|studio)\/(\d+)(?:\/\|$)/` | 1: kind, 2: id |
| User profile and subpages | `/^\/user\/([^/]+)(?:\/\|$)/` | 1: username |
| Anime or manga list | `/^\/user\/([^/]+)\/(anime\|manga)list(?:\/\|$)/i` | 1: username, 2: kind |
| List compare page | `/^\/user\/([^/]+)\/(anime\|manga)list\/compare(?:\/\|$)/i` | 1: username, 2: kind |
| Browse search | `/^\/search\/(anime\|manga)\/?$/` | 1: kind |
| Settings | `/^\/settings(?:\/\|$)/` | none |

Inside a table cell the pipes are escaped for Markdown. In code, write them as plain `|`.

Notes:

- Usernames are URL-encoded in the path. Decode them with `decodeURIComponent`, inside a `try` block, because a malformed sequence throws.
- Media URLs may carry a title slug (`/anime/1/some-title`). The patterns above ignore it, so they match with or without a slug.
- Build `MediaRoute`-style objects yourself from the capture groups, for example `type: kind.toUpperCase()`.

---

## Mounting DOM Elements

`ctx.mount(spec)` and `rc.mount(spec)` place an element and keep it in place. `ctx.mount` lasts until the module unloads, `rc.mount` until the route run ends. Both return a function that removes the mount early.

```ts
rc.mount({
  id: 'ala-example',
  anchor: '.sidebar > .data',
  position: 'beforebegin',
  match: () => someCondition(),
  ownUi: true,
  create: () => document.createElement('div')
});
```

| Field | Description |
| :--- | :--- |
| `id` | Element id. Prefixed with `ala-` unless it already starts with it. Used to detect an existing element and to register own UI. |
| `anchor` | A CSS selector or a function returning the element to insert relative to. |
| `position` | An `insertAdjacentElement` position. Defaults to `afterend`. |
| `create` | Returns the element to insert. |
| `match` | Optional gate. When it returns `false` an existing element is removed. |
| `ownUi` | Register `#<final id>` as [own UI](#observer-exclusions). Needs an element id. |

Behavior:

- The mount is attempted at DOM ready, on every navigation, and after every batch of page mutations.
- With an `id`, the inserted element's id is set to the prefixed id, replacing whatever `create()` assigned. Without an `id`, an id set by `create()` is prefixed the same way.
- If the element is still connected, nothing happens. If an element with the final id already exists, it is adopted instead of duplicated.
- If the page removes your element, `create()` runs again and the element is re-inserted. Keep `create()` cheap.
- An existing element is never updated. To change its content, update it yourself or remove the mount and add a new one.
- If the anchor never appears, the mount waits silently and retries as the page changes.

Selectors for AniList's own markup are not shared. Keep them as constants at the top of your module so a site change touches one line.

---

## Styles

```ts
ctx.addStyle('ala-example-style', `.ala-example { color: rgb(var(--color-text)); }`);
```

- Adds a `<style id="...">` to `<head>` (waiting for it if needed). The tag is removed when the last user of that id unloads.
- The id gets an `ala-` prefix unless it already starts with it, so `example-style` becomes `ala-example-style`. An empty id becomes `ala-style`.
- Ids are shared and reference counted across modules. If a tag with the final id already exists, it is reused and the new CSS text is not applied. Use unique ids, and prefix class names (`ala-`) to avoid colliding with AniList.
- Use AniList's CSS variables so themes keep working: `--color-foreground`, `--color-background`, `--color-text`, `--color-text-lighter`, `--color-blue`, `--color-green`, `--color-red`. They hold comma-free RGB triplets, so wrap them as `rgb(var(--color-text))` or `rgba(var(--color-blue), .3)`.

---

## Observer Exclusions

The shared body observer would otherwise report your own DOM updates back to every module. Two tools prevent that:

| Tool | What it does |
| :--- | :--- |
| `ctx.ownUi(selector)` | Mutations inside matching elements are not delivered to `onBodyMutation` callbacks. Returns a cleanup. |
| `ctx.silently(fn)` | Runs `fn` with navigation notifications muted, then resets the baseline URL. Use it when you rewrite the URL yourself, for example with `history.replaceState`, and do not want modules to treat it as navigation. |

`ctx.ownUi` takes a selector as written, without any prefixing, and is tested with `closest()`. For mounted elements, `ownUi: true` on the spec is the shorter way and already uses the final id. Only register containers that your module alone owns, otherwise other modules stop seeing changes inside them.

---

## Timers and Listeners

| Method | Description |
| :--- | :--- |
| `ctx.listen(target, type, listener, options?)` | `addEventListener` that is removed on unload. |
| `ctx.interval(fn, ms)` | `setInterval` cleared on unload. |
| `ctx.timeout(fn, ms)` | `setTimeout` cleared on unload. |

Each returns a function that cancels it early. Prefer these over raw `setInterval` and `addEventListener`, which would survive a hot-reload and run the old code alongside the new.

Calling `window.addEventListener(...)` or `document.addEventListener(...)` directly in a module is rejected by the convention tests. Listeners on elements you created yourself (`button.addEventListener(...)`) are fine, because they disappear with the element. For global listeners inside helper code or modal builders, accept a `listen` function as a parameter and pass `ctx.listen` (or `rc.listen`, or the `listen` member of a JSON editor context).

---

## Networking

`ctx.http` wraps the userscript manager's cross-origin request API. Every host you call must be listed in `userscript.connect` in `vite.config.ts` (see [Calling External APIs](./recipes.md#calling-external-apis)). For AniList GraphQL use `ctx.api` instead, which adds caching and rate limiting.

| Method | Resolves with |
| :--- | :--- |
| `http.request(url, opts?)` | The raw response (`status`, `responseText`, `responseHeaders`), whatever the status. |
| `http.text(url, opts?)` | `responseText`. Throws `HTTP <status>` outside 200 to 299. |
| `http.json<T>(url, opts?)` | Parsed JSON. Throws like `text`. |
| `http.download(url, name, opts?)` | `'download'` or `'tab'`. |

`opts` is passed through to the underlying request: `method` (default `GET`), `headers`, `data`, `timeout` (default 15000 ms), `responseType`, `anonymous`, and so on.

- Network errors, timeouts, and aborts reject with `Network error`, `Timeout`, and `Request aborted`.
- Requests still in flight when the module unloads are aborted and reject with `Request aborted`. Treat that as normal control flow, not as an error to report.
- `download` saves the file using the userscript manager. If that fails it opens the URL in a new tab and resolves `'tab'`, unless you pass `openTabOnError: false`, in which case it rejects. An unload rejects with `Download aborted` (or `Request aborted` if the download does not abort synchronously). Pass `saveAs: true` to show a file dialog.

The lower-level `gm` and `downloadFile` helpers in `utils/helpers` are for core code only. Modules that import or call them fail the convention tests. Pair requests with `rc.signal` checks so late responses do not touch a torn-down page.

---

## Toasts

```ts
ctx.toast.success('Saved');
ctx.toast.error('Something failed');
ctx.toast.show('Working...', { type: 'info', durationMs: 3000 });
```

- There is one shared toast element, so a new toast replaces the current one.
- `durationMs` defaults to 6000. `0` keeps it until replaced.
- `closeTab: true` closes the browser tab 1.8 seconds later. It is meant for OAuth tabs that finished their job.

---

## Menu Commands

```ts
ctx.menuCommand('Reset my module data', () => ctx.storage.clear());
```

Adds an entry to the userscript manager's menu. Managers cannot remove entries, so the kernel registers each label once and swaps the handler on later calls. Unloading clears the handler, which makes the entry a no-op until the module returns. Labels are shared by every module, so make them specific.

---

## Using ctx From Sibling Files

Larger modules split code into files next to `index.ts`. Those files cannot import `Settings`, the `AniList` singleton, or the storage helpers, so they receive what they need from `setup(ctx)`. Three patterns cover almost everything.

**Pass the context.** Type the parameter with `FeatureContext`. Use `FeatureContext<true>` when the helper calls `ctx.log.debug`, and pass the declared account id union as the second type argument (`FeatureContext<false, 'mal'>` or `FeatureContext<true, 'mal'>`) when it uses `ctx.accounts`.

```ts
import type { FeatureContext } from '../../types';

export function renderPanel(ctx: FeatureContext<true>): void {
  ctx.log.debug('Rendering panel');
}
```

**Pass values or functions.** Keep helpers pure so tests need no setup. Give optional settings a default:

```ts
export function parseConfig(raw?: unknown): Config {
  if (raw === undefined) return structuredClone(DEFAULT_CONFIG);
  return isValid(raw) ? (raw as Config) : structuredClone(DEFAULT_CONFIG);
}

// in setup(ctx)
const config = parseConfig(ctx.get('exampleConfig'));
```

Functions such as `ctx.get`, `ctx.listen`, and `ctx.addStyle` can be passed as plain parameters, because they do not depend on `this`.

**Hold it in a module-level variable.** When many functions in a file need the same dependency, store it once and clear it on unload so late callbacks fail soft:

```ts
import type { AniListClient } from '../../types';

let api: AniListClient | null = null;
export const setApi = (next: AniListClient | null): void => {
  api = next;
};

export async function loadMedia(id: number) {
  return api?.media.get(id, 'ANIME') ?? null;
}

// in setup(ctx)
setApi(ctx.api);
ctx.onCleanup(() => setApi(null));
```

Remember that module-level state survives a hot-reload only until the cleanup runs, so reset anything stateful there. Settings editors for `json` options get the same kind of tools bundled in one object, see [Child Options](./define-module.md#child-options).

---

## Logging

`ctx.log` is the only way for modules to write to the console.

| Member | Description |
| :--- | :--- |
| `warn(...)`, `error(...)` | Always print, prefixed with `[label]`. Still print after unload. |
| `debug(...)` | Prints only while active and when Developer Mode and the module's debug toggle are on. A compile-time error unless the module enables `debug` without `debug: false`. |
| `enabled()` | `true` when `debug` would print. Use it to skip building expensive arguments. |
| `channel(id)` | A sub-logger with its own toggle. Names are type-checked against the declared channels. |
| `label`, `title`, `help`, `canDebug` | Metadata. |

```ts
if (ctx.log.enabled()) ctx.log.debug('payload', JSON.stringify(payload));
ctx.log.channel('rpc').debug('request sent');
```

Declaring `debug` and channels is covered in [Debug Logging](./define-module.md#debug-logging). Never log tokens, authorization headers, or other secrets, even at debug level. Importing `createLogger`, `isDebugEnabled`, `getDebuggableChannels`, or `createCoreLogger` in a module is rejected by the convention tests.

Files in `core/`, `settings/`, and `api/` cannot use `ctx`, so they use `createCoreLogger`. See [Core Logging](./platform-apis.md#core-logging).
