# Context API

Every active module receives its own `ctx` (a `FeatureContext`) in `setup(ctx)`. Anything you create through `ctx` is tracked and removed when the module is disabled, hot-reloaded, or fails. After disposal, lifecycle registrations, DOM mounts, timers, listeners, HTTP requests, settings and storage writes, toasts, `silently` calls, account mutations, `ctx.api` mutations and cache clears, and event or hook mutations stop or abort, so a late timer or promise cannot revive a dead module.

This reference covers the runtime API. Related members live elsewhere:

| Member | Where it is documented |
| :--- | :--- |
| `ctx.session`, `ctx.api`, `rc.api`, `ec.api` | [AniList Session](./platform-apis.md#anilist-session) and [AniList API Client](./platform-apis.md#anilist-api-client) |
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
- `ctx.set(key, value)` normalizes and saves a value (ignored after disposal). It does not reload any module. Use it to remember a user choice made outside the Settings panel.

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

For a larger object that you mutate often, use `ctx.persistent`, which returns a `PersistentCache<T>` (`{ data, save, cancel, flush }`):

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

- `data` loads lazily on first access, and the optional prune function runs once right after loading. You can mutate `data` in place or reassign `cache.data = nextValue`.
- Call `save()` after changes. Saves are debounced by 500 ms. The `PersistentCache<T>` handle also exposes `flush()` (write any pending change immediately) and `cancel()` (drop a pending save).
- While the module is active, using `ctx.persistent` lazily registers a `window` `pagehide` listener that automatically calls `flush()` on pending caches before tab closure or page reload (such as Settings **Save and reload**).
- Pending save timers are cancelled automatically (and the `pagehide` listener is removed) when the module unloads, is disabled or hot-reloaded, or when `ctx.storage.clear()` is called, and `save()` / `flush()` do nothing after disposal.
- The key is scoped to your module exactly like `ctx.storage`: it is stored as `ala_mod_<id>_<key>`, so a short name is enough and it cannot collide with another module. `ctx.storage.clear()` deletes it from storage. The object you already loaded stays in memory, and the next `save()` writes it again.
- Include a version suffix in the key. When the shape changes, use a new suffix and delete the old key in a [migration](./define-module.md#migrations). Keys written by older script versions without the module prefix are removed with `m.legacy.del(oldKey)`.
- Data stays after the module is disabled. Use a prune function or expiry timestamps to keep it from growing.

Use `ctx.storage` for small settings-like values and `ctx.persistent` for caches. Never import `persistent` from `utils/helpers` in a module.

---

## Lifecycle and Cleanup

| Member | Description |
| :--- | :--- |
| `ctx.signal` | Read-only `AbortSignal` that aborts as soon as module teardown begins (before cleanups run). Pass it to async work or abort-aware APIs. |
| `ctx.onCleanup(fn)` | Run `fn` when the module unloads. Use it for anything you created without `ctx`. |
| `ctx.trackEl(el)` | Remove `el` when the module unloads. Returns the element. |
| `ctx.ready(cb)` | Run `cb` once `document.body` exists, immediately if it already does. |
| `ctx.onNav(cb)` | Run `cb` whenever the URL changes. |
| `ctx.onBodyMutation(cb)` | Run `cb(mutations)` for batched DOM changes. |
| `ctx.observe(target, options, cb)` | Lifecycle-scoped `MutationObserver` on `target` (`Node \| null \| undefined`). No-ops safely if closed, `target` is missing, or `MutationObserver` is unavailable; suppresses callbacks after disposal and disconnects automatically on unload. |
| `ctx.waitForSelector(sel, timeoutMs?)` | Resolve with the element (checking immediately when `document.body` first becomes ready if called at `document-start`), or `null` on timeout (default 8000 ms), invalid selector, `timeoutMs <= 0` (when absent), or unload. `Infinity` waits until matched or aborted. |

Cleanups are tracked in a `Set<CleanupFn>` and run in reverse order of registration. One-shot helpers (`timeout`, `raf`, `listen` with `{ once: true }`, and completed or cancelled `debounce` calls) prune themselves from the cleanup set automatically when they fire or cancel. A cleanup that throws is logged and does not stop the others. Once teardown starts, `ctx.signal` aborts, new live resource registrations (timers, listeners, mounts, styles, observers, routes, modals) are ignored or immediately disposed, and cleanups added with `ctx.onCleanup` during teardown still execute.

**Navigation detection** fires when `location.href` changes. The kernel patches `history.pushState` and `replaceState` (guarded by a global symbol so re-evaluation never stacks wrappers) and lazily attaches `popstate` and `hashchange` listeners plus a 400 ms poll safety net while at least one navigation subscriber is active, stopping them when the last subscriber leaves. Hash-only changes count. Prefer [ctx.onRoute](#routing) for page-specific work, because it also handles teardown.

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
| `rc.getId(name?)` | Allocate a namespaced element id (`ala-<id>-...`), matching `ctx.getId`. |
| `rc.onCleanup(fn)` | Run `fn` at teardown (immediately if already torn down). |
| `rc.ready(cb)`, `rc.onBodyMutation(cb)` | Same as the `ctx` versions, scoped to this route run. |
| `rc.listen`, `rc.interval`, `rc.timeout`, `rc.debounce`, `rc.raf`, `rc.observe` | Same as the `ctx` versions, scoped to this route run. |
| `rc.mount(spec)` | [Mount](#mounting-dom-elements) an element for this route run. Returns a `MountHandle<T>`. |
| `rc.addStyle(...)` | Inject [styles](#styles) scoped to this route run. |
| `rc.modal(opts)` | Open a [modal](#modals) scoped to this route run (closes automatically at route teardown). |
| `rc.confirm(opts)`, `rc.alert(opts)` | Open non-blocking stacked [dialogs](#modals) scoped to this route run, resolving immediately to `false` / `undefined` when the route tears down or the module unloads. |
| `rc.waitForSelector(sel, ms?)` | Like `ctx.waitForSelector`, also resolves `null` at teardown. |
| `rc.http` | Same `{ request, text, json, download }` interface as [ctx.http](#networking), automatically bound to `rc.signal` (and composed with any `opts.signal`). |
| `rc.api` | Same `Omit<AniListClient, 'session'>` interface as [ctx.api](./platform-apis.md#anilist-api-client), automatically bound to `rc.signal` (and composed with any caller `signal`). Use `rc.api` for route-scoped reads and keep `ctx.api` for intentional route-surviving mutations. |

A handler may return a cleanup function or a promise of one. If a handler throws synchronously or rejects while its route run is still active, any partial `rc.*` resources it already registered are rolled back immediately. For async handlers, always re-check `rc.signal.aborted` after an `await`. Mounts and listeners created after teardown are ignored automatically, but your own state changes are not:

```ts
ctx.onRoute(/^\/anime\/(\d+)/, async (rc) => {
  const data = await rc.api.media.get(Number(rc.match![1]), 'ANIME');
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
- The list pattern above also matches subpaths such as `/compare`; anchor with `\/?$/i` when a module should run only on the list page itself.
- Build `MediaRoute`-style objects yourself from the capture groups, for example `type: kind.toUpperCase()`.

---

## Element IDs

`ctx.getId(name?)` (and `rc.getId(name?)` on routes) generates module-namespaced DOM IDs:

```ts
ctx.getId('panel');        // "ala-<id>-panel"
ctx.getId('ala-panel');    // "ala-panel" (kept as-is if already prefixed with ala-)
ctx.getId();               // "ala-<id>-1", "ala-<id>-2", ...
```

Use `ctx.getId(...)` instead of hardcoding `'ala-'`, `'daiya-'`, or `'almal-'` string literals in modules.

---

## Mounting DOM Elements

`ctx.mount<T>(spec)` and `rc.mount<T>(spec)` (`T extends Element = HTMLElement`) place an element, inject optional styles, and keep the element in place. `ctx.mount` lasts until the module unloads, `rc.mount` until the route run ends. Both accept a `MountSpec<T>` and return a `MountHandle<T>` (`{ id, selector, el(), unmount, refresh }`).

```ts
const badge = rc.mount({
  id: 'badge',
  anchor: '.sidebar > .data',
  position: 'beforebegin',
  match: () => someCondition(),
  ownUi: true,
  style: (sel) => `${sel} { color: rgb(var(--color-text)); }`,
  create: () => document.createElement('div'),
  onMount: (el) => {
    const onClick = () => {};
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }
});
// badge.id === 'ala-<modId>-badge', badge.selector === '#ala-<modId>-badge'
// badge.el() returns the live T | null; badge.refresh() re-evaluates now; badge.unmount() removes it early
```

| Field | Description |
| :--- | :--- |
| `id` | Optional local id. Resolved with `ctx.getId(id)`, or `ala-<modId>-mount-<n>` when omitted. Assigned to the element's `.id` and used for `ownUi`. |
| `anchor` | A CSS selector or a function returning the element to insert relative to. |
| `position` | An `insertAdjacentElement` position. Defaults to `afterend`. |
| `create` | Returns the element `T` to insert, or `null` to skip mounting. |
| `match` | Optional gate. When it returns `false` an existing element is removed (and any `onMount` cleanup runs). |
| `ownUi` | Register `#<final id>` as [own UI](#observer-exclusions). |
| `style` | Optional `string \| ((selector: string) => string)` (`MountStyleSource`). Injected as `<id>-style` right before DOM insertion and removed when unmounted. |
| `onMount` | Optional `(el: T) => void \| CleanupFn`. Runs when the element is inserted or an existing element with the resolved id is adopted. Any returned cleanup runs when the element is detached, replaced, hidden by `match()`, or unmounted. |

Behavior:

- The mount is attempted at DOM ready, on every navigation, after every batch of page mutations, and whenever you call `handle.refresh()`.
- The resolved id is assigned to `el.id`, replacing whatever `create()` set.
- If the element is still connected, nothing happens. If an element with the resolved id already exists, it is adopted instead of duplicated (`style`, `ownUi`, and `onMount` are still ensured).
- If `onMount` returns a cleanup function, it runs automatically when the element is detected as detached from the DOM, `match()` returns `false`, a replacement element mounts, or `handle.unmount()` / route teardown / module disposal runs.
- If `style` is given, its `<style>` tag is injected before insertion and preserved across mid-route re-render repairs. Calling `handle.unmount()` or leaving the route removes both the element and its mount style.
- `handle.el()` returns `null` once `handle.unmount()`, route teardown, or module disposal occurs; `handle.refresh()` becomes a no-op.
- If the page removes your element, `create()` runs again and the element is re-inserted. Keep `create()` cheap, and attach listeners on the element you create with `el.addEventListener(...)` (or clean them up via `onMount`) rather than `rc.listen(el, ...)` so re-mounts do not retain detached nodes until route teardown.
- An existing element is never updated. To change its content, update it yourself or unmount and remount.
- If the anchor never appears (or has no parent element for `beforebegin`/`afterend`), the mount waits silently and retries as the page changes.

Selectors for AniList's own markup are not shared. Keep them as constants at the top of your module so a site change touches one line.

---

## Styles

```ts
ctx.addStyle(`.ala-example { color: rgb(var(--color-text)); }`);
ctx.addStyle('modal', (/* or a function: () => string */) => `${modalSel} { padding: 16px; }`);
```

- Pass one argument `addStyle(css)` (`CssSource`: `string | (() => string)`) to allocate an automatic stylesheet id (`ala-<id>-style-<n>` on `ctx`, or `ala-<id>-route-style-<n>` on `rc`).
- Pass two arguments `addStyle(name, css)` to name a shared or updatable tag. Names starting with `ala-` are preserved; other names become `ala-<id>-<name>-style` (avoiding double `-style`).
- Lazy CSS functions are evaluated immediately when `<head>` already exists, or when `Core.ready` fires (`document.body` / `DOMContentLoaded`) if `<head>` is absent at call time. If a `<style>` with the resolved id already exists, its `textContent` is updated in place without duplicating the tag, and reference counts keep it alive until the last user cleans up.
- Do not pass hardcoded `'ala-'`, `'daiya-'`, or `'almal-'` string literals to `ctx.addStyle`, `mount({ id })`, or `modal({ id })` in feature modules; `conventions.test.ts` rejects them.
- Use AniList's CSS variables so themes keep working: `--color-foreground`, `--color-background`, `--color-text`, `--color-text-lighter`, `--color-blue`, `--color-green`, `--color-red`. They hold comma-free RGB triplets, so wrap them as `rgb(var(--color-text))` or `rgba(var(--color-blue), .3)`.

---

## Observer Exclusions

The shared body observer would otherwise report your own DOM updates back to every module. Two tools prevent that:

| Tool | What it does |
| :--- | :--- |
| `ctx.ownUi(selector)` | Mutations inside matching elements are not delivered to `onBodyMutation` callbacks. Returns a cleanup. |
| `ctx.silently(fn)` | Runs `fn` with navigation notifications muted, then resets the baseline URL when the outermost call finishes (nested calls are counted). Use it when you rewrite the URL yourself, for example with `history.replaceState`, and do not want modules to treat it as navigation. |

`ctx.ownUi` takes a selector as written, without any prefixing, and is tested with `closest()`. For mounted elements, `ownUi: true` on the spec is the shorter way and already uses the final id. Only register containers that your module alone owns, otherwise other modules stop seeing changes inside them. `ctx.silently` is ignored after disposal.

---

## Timers and Listeners

| Method | Description |
| :--- | :--- |
| `ctx.listen(target, type, listener, options?)` | `addEventListener` that is removed on unload and suppresses callbacks once teardown begins (`signal.aborted`). `{ once: true }` listeners also prune their cleanup entry once fired. |
| `ctx.interval(fn, ms)` | `setInterval` cleared on unload. |
| `ctx.timeout(fn, ms)` | `setTimeout` cleared on unload and pruned from cleanups once fired. |
| `ctx.debounce(fn, ms?)` | Trailing-edge debounce (default `0` ms) returning a `DebouncedFn<T>` with `.cancel()` and `.flush()`. Pending timers cancel on unload and prune once fired/cancelled; `flush()` is a no-op after disposal. |
| `ctx.raf(fn)` | `requestAnimationFrame` wrapper (falling back to a ~16 ms timer if unavailable) cleared on unload and pruned once fired. |
| `ctx.observe(target, options, cb)` | `MutationObserver` on `target` (`Node \| null \| undefined`) disconnected on unload and guarded against firing after disposal (returns a no-op cleanup if `target` is missing, scope is closed, or `MutationObserver` is unavailable). |

`rc.listen`, `rc.interval`, `rc.timeout`, `rc.debounce`, `rc.raf`, and `rc.observe` work identically, scoped to the current route run. Each timer/listener/raf/observer returns a function that cancels or disconnects it early. Raw `setTimeout` and `setInterval` are rejected in modules outside `modules/fastLoad/config.ts`, `modules/fastLoad/domOptimizers.ts`, `modules/fastLoad/worker.ts`, and `modules/sync/state.ts`, and raw `new MutationObserver` is rejected in `src/modules/**` outside `modules/fastLoad/domOptimizers.ts`, because unmanaged timers and observers survive hot-reloads and route changes.

Calling `addEventListener(...)` directly on `window`, `document`, `globalThis`, or `unsafeWindow` in a module (including cast or bracket-access forms) is rejected by the convention tests. Listeners on elements you created yourself (`button.addEventListener(...)`) are fine, because they disappear with the element. For global listeners inside helper code or modal builders, accept a `listen` function as a parameter and pass `ctx.listen` (or `rc.listen`, or the `listen` member of a JSON editor context).

---

## Networking

`ctx.http` (and `rc.http` on routes) implement the shared `HttpClient` interface wrapping the userscript manager's cross-origin request API. Every host you call must be listed in `userscript.connect` in `vite.config.ts` (see [Calling External APIs](./recipes.md#calling-external-apis)). For AniList GraphQL use `ctx.api` (or `rc.api` in route handlers) instead, which adds caching and rate limiting.

| Method | Resolves with |
| :--- | :--- |
| `http.request(url, opts?)` | The raw response (`status`, `responseText`, `responseHeaders`), whatever the status. |
| `http.text(url, opts?)` | `responseText`. Throws `HTTP <status>` outside 200 to 299. |
| `http.json<T>(url, opts?)` | Parsed JSON (uses `response` directly when `responseType: 'json'` is set). Throws like `text`. |
| `http.download(url, name, opts?)` | `'download'` or `'tab'`. |

`opts` is passed through to the underlying request: `method` (default `GET`), `headers`, `data`, `timeout` (default 15000 ms), `responseType`, `signal` (`AbortSignal` to cancel the request), `anonymous`, and so on.

- `ctx.http` binds every `request`, `text`, `json`, and `download` call to `ctx.signal` (`ac.signal`), and `rc.http` binds every call to `rc.signal` (each composing with any caller `opts.signal`), so in-flight requests and downloads abort immediately when module teardown starts or on route navigation.
- Network errors, timeouts, and aborts (via module unload, route teardown, or `opts.signal`) reject with `Network error`, `Timeout`, and `Request aborted`.
- Requests still in flight when the module unloads (or when the route tears down for `rc.http`) are aborted and reject with `Request aborted`. Treat that as normal control flow, not as an error to report.
- `download` saves the file using the userscript manager. If that fails it opens the URL in a new tab and resolves `'tab'`, unless you pass `openTabOnError: false`, in which case it rejects. An unload or route abort rejects with `Download aborted` (or `Request aborted` if the download does not abort synchronously). Pass `saveAs: true` to show a file dialog.

The lower-level `gm` and `downloadFile` helpers in `utils/helpers` are for core code only. Modules that import or call them fail the convention tests. Pair `ctx.http` requests with `rc.signal` checks, or use `rc.http` directly inside `ctx.onRoute(...)`, so late responses do not touch a torn-down page.

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
- Calls to `ctx.toast` are ignored after disposal.

---

## Modals

`ctx.modal(opts)` and `rc.modal(opts)` open a managed dialog modal wired with backdrop dismissal, `Escape` key handling, a close button, `.ala-core-backdrop`/`.ala-core-sheet` styling, `ownUi` registration, and automatic close on module unload (or route teardown for `rc.modal`):

```ts
const modal = ctx.modal({
  id: 'details',
  title: 'Item Details',
  subtitle: 'Optional escaped subtitle',
  maxWidth: '640px',
  style: (sel) => `${sel} .ala-details { margin: 0; }`,
  bodyHtml: '<p>Loading...</p>',
  footerHtml: `
    <button class="ala-btn ala-btn--primary" data-act="ok" type="button">Done</button>
    <button class="ala-btn" data-ala-close type="button">Close</button>
  `,
  onClose: () => controller.abort()
});
```

- `id` is optional and resolved via `ctx.getId(opts.id?.trim() || 'modal-<n>')` (empty or whitespace-only values fall back to `'modal-<n>'`; do not hardcode `'ala-'`, `'daiya-'`, or `'almal-'` prefixes). Opening a modal with the same resolved `id` closes the previous instance first (`onClose` fires and its listeners, styles, and `ownUi` registration clean up).
- `ModalOptions` accepts `subtitle?: string` (rendered HTML-escaped beneath the title) and `style?: MountStyleSource` (`string | ((selector: string) => string)`, injected as `<id>-style` before the modal appends and removed automatically when it closes).
- Clicking any non-disabled element matching `[data-ala-close]` inside the modal backdrop closes the modal, unless a handler on that click called `e.preventDefault()`.
- Returns a `ModalHandle`: `{ id, selector, signal, backdrop, sheet, body, footer, close, listen, timeout, onCleanup }`.
  - `id` and `selector` (`#${id}`) identify the backdrop element.
  - `signal` (`readonly AbortSignal`) aborts before modal cleanups and `onClose` run.
  - `listen`, `timeout`, and `onCleanup` scope resources directly to the modal's lifetime (with self-pruning `{ once: true }` listeners and timers).
  - Call `modal.close()` to dismiss programmatically (`onClose` fires once). If `document.body` is `null` (or the parent scope is already disposed), an inert handle with an already-aborted `signal` is returned without attaching DOM nodes or listeners, and `onCleanup(fn)` runs `fn()` immediately.
- Stacked modals (including modals opened over the Settings panel) close top-most first on `Escape`, and ref-counted page scroll locking (`document.documentElement.style.overflow = 'hidden'`) stays active until the Settings panel and all open modals close, regardless of close order.
- **Non-blocking dialogs (`ctx.confirm`, `ctx.alert`, `rc.confirm`, `rc.alert`):** Never call blocking `window.confirm()` or `window.alert()`. Instead use `await ctx.confirm(opts)` / `await rc.confirm(opts)` (`string | ConfirmOptions`, returning `Promise<boolean>`) and `await ctx.alert(opts)` / `await rc.alert(opts)` (`string | AlertOptions`, returning `Promise<void>`). Both open stacked modals built on `createModal` (escaping all text), resolve immediately to `false` / `undefined` on Cancel, `Escape`, backdrop click, or scope/route disposal, and support `{ id?, title?, subtitle?, message, maxWidth?, signal? }` (`ConfirmOptions` also accepts `confirmText?`, `cancelText?`, and `danger?`, which styles the confirm button with `.ala-btn--danger` and focuses Cancel by default; `AlertOptions` accepts `okText?`). Passing `signal?: AbortSignal` resolves immediately without mounting when already aborted, or closes the dialog via `handle.close()` and resolves `false` / `undefined` if aborted while open.
- `JsonEditorContext` exposes a per-session `ContextScope` with `signal`, `getId`, `addStyle`, `listen`, `timeout`, `observe`, `modal(...)`, `confirm(...)`, `alert(...)`, `toast` (`ToastApi`), `onCleanup`, and an optional lifecycle-scoped `api` (`Omit<AniListClient, 'session'>` bound to `ec.signal`, aborting in-flight queries/reads and rejecting post-close mutations when the session or Settings panel closes). Any open session modal or dialog auto-closes when the Settings panel closes (while `#ala-toast` is preserved), re-opening the same option's editor disposes any prior active session, and `onApply` normalizes values before staging and becomes a no-op once the session disposes or the panel detaches. Closing the last modal in a synchronous editor session aborts `ec.signal` and disposes all session cleanups (or immediately if `editor(ec)` throws with no open modals), while `async` editors returning a Promise stay alive across intermediate confirm/modal transitions until the returned Promise settles with zero open modals (with Settings panel close as a fallback).

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
import type { FeatureContext } from '../../types';

let api: FeatureContext['api'] | null = null;
export const setApi = (next: FeatureContext['api'] | null): void => {
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
