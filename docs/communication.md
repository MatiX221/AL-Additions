# Inter-Module Communication

Modules cannot import each other, see [Import DAG](./architecture.md#import-dag). When they need to coordinate, the kernel offers three typed channels. Pick the simplest one that fits:

| You want to... | Use |
| :--- | :--- |
| Let another module call a function you own | [Services](#services) |
| Tell other modules that something happened | [Events](#events) |
| Share the state of a request pipeline, auth header, or cache | [Hooks](#hooks) |

All three are tracked by the module's `ctx`. Subscriptions are removed when the module unloads, and anything a module provides is withdrawn at the same moment.

Both services and events are typed through declaration merging on interfaces in `src/types.ts`. A declaration lives in the file of the module that owns the name, and every other module sees it automatically, so mistakes surface as compile errors.

---

## Services

A service is a named function or object that one module publishes and others look up. The owner is optional from the consumer's point of view: the consumer must cope with the service being absent, because the owner can be disabled at any time.

### Declare and provide

Names are always `<ownerId>:<localName>`. Declare the contract once, in the owning module:

```ts
declare module '../../types' {
  interface ServiceMap {
    'myProvider:openDialog': (mediaId: number) => void;
  }
}

defineModule({
  id: 'myProvider',
  key: 'myProviderEnabled',
  layer: 'service',
  title: 'My Provider',
  help: 'Offers a dialog to other modules.',
  setup(ctx) {
    ctx.services.provide('openDialog', (mediaId) => {
      showDialog(mediaId, ctx.addStyle);
    });
  }
});
```

- `provide(localName, impl)` accepts only local names that exist in `ServiceMap` under your own id, and checks `impl` against the declared type. It returns a cleanup, which also runs automatically on unload.
- Providing the same name again replaces the earlier implementation. Only the latest provider is active, and withdrawing an older registration later does not remove the newer one.
- Put providers in the `service` layer (or earlier) so consumers in the `feature` layer find them already registered.

### Consume

```ts
setup(ctx) {
  let open = ctx.services.get('myProvider:openDialog') ?? null;

  ctx.services.onAvailable('myProvider:openDialog', (fn) => {
    open = fn;
    renderButton(fn);
    return () => {
      if (open === fn) open = null;
      removeButton();
    };
  });
}
```

| Method | Description |
| :--- | :--- |
| `get(fullName)` | The implementation, or `undefined`. |
| `onAvailable(fullName, cb)` | Call `cb(impl)` now if the service exists, and again each time it appears or is replaced. The function you return is the cleanup for that appearance, and runs when the service is withdrawn or replaced, or when you unsubscribe. |

Neither module imports the other. If the provider is turned off in Settings without a page reload, the consumer's cleanup runs and its button disappears.

---

## Events

Events broadcast that something happened. Emitters do not know who is listening.

### Declare

```ts
declare module '../../types' {
  interface EventMap {
    'myModule:updated': { mediaId: number };
    'myModule:ready': void;
  }
}
```

An event typed `void` is emitted without a payload. A payload type that includes `undefined` makes the argument optional.

### Plain events

```ts
ctx.events.emit('myModule:updated', { mediaId: 123 });

ctx.events.on('myModule:updated', (payload) => {
  refreshRow(payload.mediaId);
});
```

`on` only hears events emitted after you subscribed, and returns a cleanup (also run on unload). A listener that throws is logged and does not stop the others. Unsubscribing during a dispatch takes effect immediately.

### Retained events

Early modules (`intercept`, `preload`) run before DOM ready, and later modules start afterwards. If a later module must learn what an earlier one already announced, use retained events:

```ts
// early module
ctx.events.emitRetained('myModule:ready');

// later module: runs now if already emitted, and for every later emit
ctx.events.onRetained('myModule:ready', () => initWidget());
```

- `emitRetained` stores the latest payload and notifies current listeners. `onRetained` replays that stored payload once on subscription.
- A plain `emit` of an event that has a retained value updates the stored payload, so late subscribers see the newest state.
- A retained value belongs to the module that emitted it. When that module unloads, its retained values are cleared. A newer value from another module or from a reloaded instance is left alone.

---

## Hooks

`ctx.hooks` exposes low-level shared state for modules that sit on the request pipeline. They exist so several modules can cooperate without each wrapping `window.fetch` again.

### Observing GraphQL traffic

```ts
const stop = ctx.hooks.onGqlFetch((ev) => {
  if (ev.phase === 'response' && ev.query.includes('SaveMediaListEntry')) {
    refreshAfterSave(ev.variables);
  }
});
```

A `GqlFetchEvent` has `phase` (`'request'` or `'response'`), `url`, `query`, `variables`, optional `operationName`, and on responses `status`, `ok`, and the parsed `data` when available.

Events come from one of two places:

- If a module has claimed fetch ownership with `markFetchOwner(true)` (the Fast Load feature does), that module reports each request itself through `emitGqlFetch`.
- Otherwise, as soon as someone subscribes on `anilist.co`, the kernel installs a single shared wrapper around `fetch`. It is removed when the last subscriber leaves, or when a module claims ownership.

Responses to AniList's own Web Worker requests are reported for mutations. `hasGqlFetchSubscribers()` tells an owner whether anyone is listening.

### Blocking and pausing

| Member | Description |
| :--- | :--- |
| `blockRpc(predicate)` | Register `(query, variables) => boolean`. When any predicate returns `true`, the matching request is answered with an empty page instead of reaching the network. Returns a cleanup. A throwing predicate counts as `false`. |
| `isRpcBlocked(query, variables)` | Ask whether a request would be blocked. Used by whoever performs requests. |
| `setPrefetchPaused(paused)` | Pass `true` to stop background hover and navigation prefetching. Returns a release function. Prefetching resumes when every holder has released. |
| `isPrefetchSuppressed()` | Whether anything is holding prefetching back. |

### Shared caches

`registerCacheBridge(bridge)` lets the module that owns AniList response caches share read access with the API client and other features, without page globals. A bridge provides `getGqlStore`, `getRpcCache`, `getRpcInflight`, `getUserMap`, `getIdMap`, `clear`, and `clearAuth`. `getCacheBridge()` returns the current bridge or `null`. Registering again replaces the bridge, and releasing an older registration never removes a newer one.

### Session and authentication

| Member | Description |
| :--- | :--- |
| `getAuthHeader()` | The captured `Authorization: Bearer ...` header, or `null`. |
| `setAuthHeader(header)` | Store a header. Empty or non-Bearer values are ignored, `null` deletes it, and nothing is stored while a session wipe is in progress. |
| `clearAuth()` | Delete the stored header and clear any cache bridge's copy. |
| `setSessionClearing(active)` / `isSessionClearing()` | Mark that a logout or backup restore is wiping the session, so in-flight requests do not write stale credentials back. Calls are counted, so nested wipes work. |

For reading the logged-in user, use [AniList Session](./platform-apis.md#anilist-session) instead of the raw header.

### Disposal behavior

Hooks that change shared state are no-ops after your module has unloaded, and a session-clearing flag you set is released automatically when you unload. Subscriptions and registrations you made are removed with the rest of your cleanups. A stale reference to an old `ctx` can never overwrite state set by a newer instance of the same module.

---

## Choosing Between Them

- Prefer **services** when the answer to "who handles this?" is one specific module and you need a return value.
- Prefer **events** when several modules might care and the sender needs no answer.
- Add a `dependsOn` entry only when your module cannot work at all without the other one, see [Dependencies](./define-module.md#dependencies). A service you can live without needs no dependency, only a null check.
