# Context API (`FeatureContext` & `RouteContext`)

When your module boots, the kernel passes a dedicated `ctx: FeatureContext` instance to `setup(ctx)`. Every resource registered through `ctx` is tied to that specific boot lifecycle and cleaned up automatically when the module stops or reloads.

---

## Settings Access

```ts
const providers = ctx.get<string[]>('nyaaProviders');
ctx.set('someOptionKey', nextValue);
```

- **`ctx.get<T>(key)`**: Reads and normalizes any registered setting via `Settings.get(key)`.
- **`ctx.set(key, val)`**: Writes and normalizes any registered setting via `Settings.set(key, val)`.

---

## Storage & Caching

### Module-Scoped Storage (`ctx.storage`)
All keys are automatically isolated under prefix `ala_mod_<moduleId>_` in Tampermonkey storage (`GM_getValue` / `GM_setValue`):

```ts
ctx.storage.set('lastChecked', Date.now());
const ts = ctx.storage.get<number>('lastChecked', 0);
ctx.storage.del('lastChecked');

// Cross-tab / live reactive updates (returns CleanupFn, auto-cleaned on module unload)
const unwatch = ctx.storage.watch('lastChecked', (shortKey, oldVal, newVal, remote) => {
  ctx.debug.log(shortKey, 'changed:', oldVal, '->', newVal, 'remote:', remote);
});

// Removes ONLY keys belonging to this module (prefixed with `ala_mod_<moduleId>_`)
ctx.storage.clear();
```

### Lazy Debounced Cache (`ctx.persistent`)
For large in-memory dictionaries that should not be parsed until actually read and should coalesce rapid writes (500ms debounce) into JSON storage using a caller-specified raw key:

```ts
const cache = ctx.persistent<Record<string, { score: number; at: number }>>(
  'my_shared_raw_cache',
  (data) => {
    // Optional pruner invoked lazily on first `.data` read
    const cutoff = Date.now() - 7 * 86400_000;
    for (const [k, v] of Object.entries(data)) {
      if (v.at < cutoff) delete data[k];
    }
  }
);

// Zero GM_getValue calls occurred until `.data` is first accessed:
cache.data['item1'] = { score: 9, at: Date.now() };
cache.save(); // Debounced 500ms write
```

---

## Navigation, Routing & Lifecycle Hooks

AniList navigates client-side via `history.pushState` / `replaceState` / `popstate` without reloading the document. Use these lifecycle helpers instead of raw `DOMContentLoaded` or `setInterval` polling:

### `ctx.ready(cb)`
Runs `cb` immediately if `document.body` exists, or once on `DOMContentLoaded`. Automatically cancelled if your module is unloaded before `DOMContentLoaded` fires.

### `ctx.onNav(cb)`
Runs `cb` whenever the URL path/query changes via SPA navigation (`pushState`, `replaceState`, `popstate`, `hashchange`). Automatically unsubscribed on unload.

### `ctx.onBodyMutation(cb)`
Subscribes to batched (`50ms`), debounced DOM mutations on `document.body`.
- Excludes mutations originating inside Settings/Core UI (`BASE_OWN_UI`) and any selector registered via `ctx.ownUi(selector)`.
- Uses a single shared lazy `MutationObserver` across all active modules (automatically disconnecting when zero listeners remain).

### `ctx.onRoute([matcher,] handler)` (Recommended for Page Features)
Combines `onNav`, cleanup management, and cancellation into one declarative primitive:

```ts
// Overload 1: Run on matched pathname RegExp or predicate (url: URL) => boolean
ctx.onRoute(/^\/(?:anime|manga)\/(\d+)/, async (rc) => {
  const mediaId = Number(rc.match?.[1]);

  // rc.signal aborts automatically if the user leaves this page before fetch resolves!
  const res = await ctx.http.json(`https://api.example.com/item/${mediaId}`).catch(() => null);
  if (rc.signal.aborted || !res) return;

  rc.mount({
    id: 'my-widget',
    anchor: '.overview',
    position: 'beforeend',
    create: () => {
      const box = document.createElement('div');
      box.id = 'my-widget';
      box.textContent = res.summary;
      return box;
    }
  });

  // Return an optional cleanup or call rc.onCleanup(...)
  return () => {
    ctx.debug.log('Left media page:', mediaId);
  };
});

// Overload 2: Run on every route change (no matcher)
ctx.onRoute((rc) => {
  ctx.debug.log('Current URL:', rc.pathname);
});
```

Every `RouteContext` (`rc`) gives you route-scoped versions of helpers that **automatically clean up when leaving that route** (as well as when the module unloads):

| Property / Method | Description |
| :--- | :--- |
| `rc.url` | Parsed `URL` object for the current navigation. |
| `rc.pathname` | Shorthand for `rc.url.pathname`. |
| `rc.match` | `RegExpMatchArray` if matched with a `RegExp`, else `null`. |
| `rc.signal` | `AbortSignal` aborted automatically as soon as the user navigates away or the module unloads. |
| `rc.onCleanup(fn)` | Registers a teardown callback for this route visit. |
| `rc.mount(spec)` | Declarative DOM mounter scoped to this route visit. |
| `rc.listen(...)` | DOM event listener automatically removed when leaving the route. |
| `rc.interval(...)` / `rc.timeout(...)` | Timers automatically cleared when leaving the route. |
| `rc.waitForSelector(sel, ms)` | Resolves selector or `null` if timeout expires or `rc.signal` aborts. |

---

## DOM Manipulation & Style Helpers

### `ctx.mount(spec)`
Mounts an element relative to an AniList container, automatically watches body mutations to re-insert it if Vue re-renders and drops it, and removes the element cleanly on cleanup:

```ts
ctx.mount({
  id: 'my-panel',                          // Optional deduplication check (`document.getElementById`)
  anchor: '.sidebar > .data',              // CSS selector string OR () => Element | null
  position: 'beforebegin',                 // InsertPosition ('beforebegin' | 'afterbegin' | 'beforeend' | 'afterend')
  match: () => /^\/anime\/\d+/.test(location.pathname), // Optional guard before mounting
  ownUi: true,                             // Register `#${id}` with observer own-UI exclusion (default true when id set)
  create: () => {
    const el = document.createElement('div');
    el.id = 'my-panel';
    return el;
  }
});
```

### `ctx.addStyle(id, css)`
Injects a `<style id="...">` element into `document.head` (or updates an existing tag) and removes it when the module unloads. Calling `addStyle` cleanly at the start of `setup(ctx)` or lazily inside modal openers ensures disabled modules leave zero CSS behind.

### `ctx.trackEl(el)`
Tracks a manually created DOM node so `el.remove()` is automatically called when the module unloads.

### `ctx.waitForSelector<T>(selector, timeoutMs = 8000)`
Resolves immediately if `document.querySelector(selector)` matches, otherwise observes body mutations until found, `timeoutMs` elapses (resolving `null`), or the module/route aborts.

### `ctx.ownUi(selector)` vs. `ctx.silently(fn)`
- **`ctx.ownUi('#my-widget')`:** Permanently ignores `MutationRecord`s inside `#my-widget` so updating your own panel never wakes up `onBodyMutation` listeners (including other modules).
  - *Tip:* Only register containers that **only your module owns**. If your module renders media cards/rows (like a custom compare table) that downstream enhancements (such as rating badges) should inspect, do **not** put the shared table itself in `ownUi`; exclude only your control sidebar.
- **`ctx.silently(fn)`:** Synchronously suppresses global `Core` observer dispatch during bulk DOM mutations inside `fn()`. Note this suppresses all observer modules for those synchronous writes.

### `ctx.onCleanup(fn)`
Registers any custom teardown function to execute in reverse registration order when the module unloads. If `fn` throws, errors are caught and logged so subsequent cleanups still execute.

---

## Event Listeners & Timers

Always prefer `ctx.listen`, `ctx.interval`, and `ctx.timeout` (or `rc.*` equivalents) over raw `addEventListener`, `setInterval`, and `setTimeout`:

```ts
ctx.listen(window, 'resize', () => recomputeLayout(), { passive: true });
ctx.interval(() => checkState(), 2000);
ctx.timeout(() => hideHint(), 3000);
```

Every listener and timer is tracked and automatically cancelled on unload, leaving no dangling callbacks firing after a hot-reload.

---

## Networking (`ctx.http`)

Wraps Tampermonkey's `GM_xmlhttpRequest` (which bypasses CORS restrictions for domains whitelisted under `@connect` in `vite.config.ts`) and aborts all in-flight requests cleanly when the module unloads:

```ts
// Returns parsed JSON (throws if HTTP status < 200 or >= 300)
const data = await ctx.http.json<{ items: any[] }>('https://api.example.com/search?q=test');

// Returns responseText (throws on non-2xx)
const html = await ctx.http.text('https://example.com/page', { timeout: 10000 });

// Raw GM response ({ status, statusText, responseText, responseHeaders, response })
const res = await ctx.http.request('https://api.example.com/post', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  data: JSON.stringify({ ok: true })
});
```

---

## User Feedback & Menu Integration

### Toasts (`ctx.toast`)
Displays non-intrusive bottom-right notifications styled to match AniList's theme (lazily injects toast CSS on first toast, safely works on both AniList and external `@match` pages):

```ts
ctx.toast.show('Syncing...', { type: 'info', durationMs: 3000 });
ctx.toast.success('Updated entry!');
ctx.toast.error('Request failed', { closeTab: false });
```

### Tampermonkey Menu (`ctx.menuCommand`)
Registers a userscript menu command that stays deduplicated across hot-reloads (re-binding the handler without stacking duplicate entries in Tampermonkey) and turns into a safe no-op when the module is disabled:

```ts
ctx.menuCommand('My Feature: Clear Cache', () => {
  ctx.storage.clear();
  ctx.toast.success('Cache cleared.');
});
```

---

## Debugging (`ctx.debug`)

```ts
if (ctx.debug.enabled()) {
  ctx.debug.log('Resolved', items.length, 'entries');
}
// Or call log directly (checks enabled automatically):
ctx.debug.log('Step finished');
```

- Automatically prefixes output with `[<CHANNEL>]` (e.g. `[MYFEATURE]`) and gates execution on **both** the global **Developer Mode** master switch (`devModeEnabled`) **and** your module's declared `debug` channel toggle (or `window.__ALA_DEBUG__ = true` override in the browser console).
