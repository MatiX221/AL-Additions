# Architecture, Communication & Testing

This guide explains how boundaries are enforced across `src/`, how modules communicate safely without creating tight coupling, and how to test new modules cleanly in Vitest.

---

## Layering DAG Rules

Imports within `src/` must form a strictly acyclic directed graph enforced automatically by `__tests__/layering.test.ts`:

```text
types.ts         ──▶ (no internal src/ imports: pure leaf types & constants)
utils/*          ──▶ types.ts, utils/*
core/*           ──▶ types.ts, utils/*, core/*
                     (exception: core/registry.ts ──▶ settings/settings.ts)
settings/*       ──▶ types.ts, utils/*, settings/*, core/* (except core/registry.ts)
                     (settings/settings.ts ──▶ types.ts, utils/* only)
api/*            ──▶ types.ts, utils/*, api/*, core/* (except core/registry.ts)
modules/<A>/*    ──▶ types.ts, utils/*, api/*, settings/settings.ts, core/registry.ts, modules/<A>/*
main.ts          ──▶ composition root (imports all modules via import.meta.glob)
```

### Key Takeaways for Module Authors
- **Never import another module** (`modules/<A>/*` importing `modules/<B>/*` fails `layering.test.ts`).
- **Never import `core/observer.ts`, `core/styles.ts`, `core/bus.ts`, `core/toast.ts`, `core/accounts.ts`, or `settings/backup.ts` directly inside `modules/*`**. Use the methods provided on `ctx` (`ctx.onBodyMutation`, `ctx.addStyle`, `ctx.hooks`, `ctx.toast`, `ctx.accounts`) instead.
- **`src/types.ts` must stay import-free within `src/`**, making shared contracts lightweight for every layer.
- Shared domain logic belongs in `src/api/*` or `src/utils/*`, not hidden inside one module that others depend on.

---

## Inter-Module Communication

When modules need to coordinate, pick the simplest mechanism that fits:

### 1. Services (`ctx.services`): Typed Request & Capability Exchange
Use services when Module B provides a capability (like opening a modal or querying a shared feature state) that Module A uses optionally. The provider declares its contract in `ServiceMap` via TypeScript declaration merging (`declare module '../../types'`), so consumers infer the exact signature automatically with zero manual generic casts:

**Provider (`service` layer, e.g. `myProvider`):**
```ts
declare module '../../types' {
  interface ServiceMap {
    'myProvider:openDialog': (mediaId: number) => void;
  }
}

defineModule({
  id: 'myProvider',
  // ...
  setup(ctx) {
    // Type-checked against ServiceMap['myProvider:openDialog']
    // Cleanup removes the service automatically when myProvider stops or disables.
    ctx.services.provide('openDialog', (mediaId) => {
      showDialog(mediaId, ctx.addStyle);
    });
  }
});
```

**Consumer (`feature` layer, e.g. `myConsumer`):**
```ts
setup(ctx) {
  let openFn = ctx.services.get('myProvider:openDialog') ?? null;

  // React dynamically as the provider boots, reloads, or gets disabled live:
  ctx.services.onAvailable('myProvider:openDialog', (fn) => {
    openFn = fn;
    renderButton(fn);

    // Optional returned CleanupFn runs automatically if the provider unloads!
    return () => {
      if (openFn === fn) openFn = null;
      removeButton();
    };
  });
}
```

Notice how neither module imports the other, deleting the provider immediately surfaces a compile error in consumers referencing its key, and if the user turns off `myProvider` in Settings without reloading the page, `myConsumer`'s button vanishes automatically.

### 2. Event Bus (`ctx.events`): Typed Broadcasts & Retained State
Declare event payloads on `EventMap` inside the emitting module using `declare module '../../types'`. Payloads typed as `void` take no payload argument on `emit` / `emitRetained`.

**Edge-triggered broadcasts (`emit` / `on`):**
```ts
declare module '../../types' {
  interface EventMap {
    'myModule:updated': { mediaId: number };
    'myModule:ready': void;
  }
}

// Emitter
ctx.events.emit('myModule:updated', { mediaId: 123 });

// Listener (automatically unsubscribed on module unload)
ctx.events.on('myModule:updated', (payload) => {
  refreshRow(payload.mediaId);
});
```

**Sticky cross-boot-phase state (`emitRetained` / `onRetained`):**
Because `intercept`/`preload` modules run before `DOMContentLoaded` (`startModules(true)`) while `service`/`feature` modules run later (`startModules(false)`), use `emitRetained` / `onRetained` when late subscribers should immediately receive the latest emitted value:

```ts
// Early module
ctx.events.emitRetained('myModule:ready');

// Later feature module (replays immediately if already emitted, plus future updates)
ctx.events.onRetained('myModule:ready', () => initWidget());
```

- Subsequent `emit()` calls on the same key update the retained payload in place so late `onRetained` subscribers always see the latest state.
- When the owning module disposes or disables, retained entries still owned by that module context are automatically cleared without disturbing newer values emitted by another module or a reloaded generation.

### 3. Core Hooks (`ctx.hooks`): Pipeline & GraphQL Coordination
Lower-level runtime hooks (`src/types.ts` -> `CoreHooksApi`) let intercept/preload/service modules coordinate without touching each other or stacking duplicate monkey-patches on `window.fetch`:

- **`ctx.hooks.onGqlFetch((ev) => ...)`**: Observe AniList `/graphql` requests (`phase: 'request'`) and parsed JSON responses (`phase: 'response'`), including cross-realm page `Request` / `URL` inputs, unconsumed response bodies (`!bodyUsed`), and AniList Worker RPC mutations. When a dedicated fetch-owner module (such as Fast Load) is active, it emits `GqlFetchEvent`s directly via `markFetchOwner(true)` + `emitGqlFetch`; otherwise `CoreHooks` installs a single shared fallback `fetch` wrapper cleanly on `anilist.co`.
- **`ctx.hooks.blockRpc(predicate)`**: Suppresses matching AniList GraphQL/RPC requests before they hit the network (returns cleanup).
- **`ctx.hooks.setPrefetchPaused(true)`**: Temporarily pauses background navigation/hover prefetching during heavy user actions (returns release function).
- **`ctx.hooks.registerCacheBridge(bridge)` / `getCacheBridge()`**: Exposes shared runtime caches cleanly across `fastLoad`, `api/anilist.ts`, and `compareView` without page-window globals.
- **`ctx.hooks.setSessionClearing(active)` / `isSessionClearing()` / `clearAuth()`**: Coordinates safe session wipes during logout or backup restores so in-flight requests do not re-persist stale auth headers.
- **`ctx.hooks.getAuthHeader()` / `setAuthHeader(header | null)`**: Scoped access to the captured AniList `Authorization: Bearer ...` header. Validates non-empty Bearer tokens, respects `isSessionClearing()`, clears automatically on `clearAuth()`, and no-ops after module context disposal.

---

## Testing Your Module

Vitest runs with `jsdom` pre-configured at `https://anilist.co/` and full Tampermonkey (`GM_*`) + WebCrypto mocks wired in `__tests__/setup.ts`.

### Pure Helper Unit Tests
Export pure transformations, parsers, and validators from your module files cleanly (with zero import-time side effects) and test them directly:

```ts
import { describe, it, expect } from 'vitest';
import { formatBadgeText } from '../src/modules/mediaIdBadge';

describe('mediaIdBadge helpers', () => {
  it('formats full and compact ID labels', () => {
    expect(formatBadgeText('anime', 16498, 'full')).toBe('ANIME #16498');
    expect(formatBadgeText('manga', 2, 'short')).toBe('#2');
  });
});
```

### Full Lifecycle & DOM Tests (`bootModuleForTest`)
To test your module's `setup(ctx)` lifecycle, `Settings` interaction, DOM injection, and `ctx.onCleanup` teardown:

```ts
import { describe, it, expect } from 'vitest';
import '../src/modules/mediaIdBadge';
import { Settings } from '../src/settings/settings';
import { bootModuleForTest, createModuleHost } from '../src/core/registry';

describe('mediaIdBadge lifecycle', () => {
  it('mounts on media pages and cleans up cleanly on disable', async () => {
    document.body.innerHTML = `<div class="sidebar"><div class="data"></div></div>`;
    history.replaceState({}, '', '/anime/16498');
    Settings.set('mediaIdBadgeEnabled', true);

    await bootModuleForTest('mediaIdBadge');
    expect(document.getElementById('ala-media-id-badge')?.textContent).toBe('ANIME #16498');

    Settings.set('mediaIdBadgeEnabled', false);
    createModuleHost().reload(['mediaIdBadge']);
    expect(document.getElementById('ala-media-id-badge')).toBeNull();
  });
});
```

### Architecture & Guard Checks Already Covering You
Running `npm test` automatically runs both `__tests__/layering.test.ts` and `__tests__/conventions.test.ts` across `src/` to guarantee:
1. No forbidden cross-layer or cross-module imports exist.
2. Dynamically importing `src/modules/<yourModule>/index.ts` triggers **zero** `GM_*`, DOM, style, or global listener side effects at import time.
3. Feature modules never bypass kernel abstractions: raw session/auth keys (`al_user_id`, `al_username`, `al_score_format`, `al_token_auth`, `al_token`, `mal_token`), `ctx.api.session`, `ANILIST_SESSION_KEYS`, hardcoded `ala_setting_`/`ala_mod_` prefixes, raw `GM_*` calls, legacy debug helpers (`ctx.debug`, `logDebug`, `isDebug`, `registerDebugChannel`), and `createCoreLogger` are all rejected in `src/modules/**`.
4. Raw `console.log`/`debug`/`warn`/`error` calls are forbidden across `src/core/**`, `src/settings/**`, `src/api/**`, and `src/modules/**` — use `ctx.log` in modules and `createCoreLogger(...)` in core/settings/API layers.
5. Every `migrate` hook/helper carries a valid `// @migration(from: "...", kind: "storage" | "import" | "cleanup", sunset: "...")` annotation.

*(Documented exceptions — such as `fastLoad`'s standalone `alfl:*` / `__ALFL_*` interop keys and `sync/state.ts`'s `SYNC_STORAGE_PREFIX` for post-dispose lock release — are explicitly allowlisted in `__tests__/conventions.test.ts`.)*

Always finish with the full verification suite before committing:

```bash
npx tsc --noEmit && npm test && npm run build
```
