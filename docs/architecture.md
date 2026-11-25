# Architecture & Guardrails

AL Additions enforces strict boundaries between its core kernel, settings, shared APIs, and feature modules. Every rule on this page is verified automatically when you run `npm test`.

---

## Five-Layer Boot Model

Active modules boot in deterministic layer order across two phases:

| Layer | Phase | Runs When | Intended Use Cases |
| :--- | :--- | :--- | :--- |
| `intercept` | Early (`document-start`) | Synchronously on script evaluation, before AniList runs. | Patching `window.fetch`, `Worker`, or page globals before AniList initializes. |
| `preload` | Early (`document-start`) | Synchronously after `intercept`. | Early route and title guards, RPC blockers, and pre-paint setup. |
| `service` | Deferred (`DOM ready`) | After `DOMContentLoaded` (or immediately if `document.body` exists). | Background sync, OAuth consumers, and shared service providers. |
| `feature` | Deferred (`DOM ready`) | After `service` modules finish booting. | Default layer. Page widgets, buttons, tooltips, and DOM enhancements. |
| `shell` | Deferred (`DOM ready`) | Last, via `registerShellModule(...)`. | Core shell UI (the Settings panel). |

Within each layer, modules are ordered topologically by `dependsOn` and `after`, with alphabetical `id` tie-breaking. For how to pick a layer and declare dependencies, check [Execution Layers](./define-module.md#execution-layers) and [Dependencies](./define-module.md#dependencies).

---

## Import DAG

Imports within `src/` must form a strictly acyclic directed graph, enforced by `__tests__/layering.test.ts`:

```text
types.ts         --> (no internal src/ imports: pure leaf types and constants)
utils/*          --> types.ts, utils/*
core/*           --> types.ts, utils/*, core/*
                     (exception: core/registry.ts --> settings/settings.ts)
settings/*       --> types.ts, utils/*, settings/*, core/* (except core/registry.ts)
                     (settings/settings.ts --> types.ts, utils/* only)
api/*            --> types.ts, utils/*, api/*, core/* (except core/registry.ts)
modules/<A>/*    --> types.ts, utils/*, api/*, core/registry.ts, modules/<A>/*
main.ts          --> composition root (discovers all modules via import.meta.glob)
```

Key takeaways for module authors:

- **Never import another module.** `modules/<A>/*` importing `modules/<B>/*` fails `layering.test.ts`. Use [Inter-Module Communication](./communication.md) instead.
- **Never import `settings/*` or any `core/*` file except `core/registry.ts`.** That covers `Settings`, `core/observer.ts`, `core/styles.ts`, `core/bus.ts`, `core/toast.ts`, `core/accounts.ts`, and `settings/backup.ts`. Use the lifecycle-tracked equivalents on `ctx`, see [Context API](./context-api.md).
- **Keep `src/types.ts` import-free.** Shared contracts stay lightweight for every layer.
- **Put shared domain logic in `src/api/*` or `src/utils/*`**, not in one module that others depend on. Page selectors and route patterns are the exception: they are small and specific to a feature, so each module keeps its own, see [Route Patterns](./context-api.md#route-patterns).
- **Files inside one module may import each other freely**, but they cannot reach `Settings` or the `AniList` singleton either. Pass values and functions in from `setup(ctx)`, see [Using ctx From Sibling Files](./context-api.md#using-ctx-from-sibling-files).

---

## Zero Import-Time Side Effects

`__tests__/layering.test.ts` dynamically imports every `src/modules/*/index.ts` and asserts that importing the file executes no runtime side effects:

- No `GM_*` calls (`GM_getValue`, `GM_setValue`, `GM_xmlhttpRequest`, `GM_registerMenuCommand`, and so on).
- No changes to `document.head` or `document.body`, and no `window.addEventListener` or `document.addEventListener` calls.

Top-level code should only declare constants, pure helper functions, and the `defineModule(...)` call. Put all runtime work inside `setup(ctx)` or `migrate(m)`.

---

## Enforced Conventions

`__tests__/conventions.test.ts` statically scans `src/` to prevent modules from bypassing kernel abstractions. Comments are ignored, but string contents are scanned, so even a quoted key in a message counts. There are no per-file exceptions. If a test fails, use this table to find the supported replacement.

| Blocked Pattern | Scope | Use Instead |
| :--- | :--- | :--- |
| Raw session keys (`al_user_id`, `al_username`, `al_score_format`) | `src/modules/**` | [ctx.session](./platform-apis.md#anilist-session) |
| Raw auth keys (`al_token_auth`, `al_token`) | `src/modules/**` | `ctx.hooks.getAuthHeader` and `setAuthHeader`, see [Hooks](./communication.md#hooks) |
| Raw MAL token key (`mal_token`) | `src/modules/**` | [ctx.accounts](./platform-apis.md#accounts) |
| `ctx.api.session` | `src/modules/**` | [ctx.session](./platform-apis.md#anilist-session) |
| `ANILIST_SESSION_KEYS` | `src/modules/**` | `ctx.session.clear()` or `ctx.api.clearViewer()` |
| `SETTING_PREFIX`, `PREFIX`, the `'ala_setting_'` prefix, importing `settings/settings`, `Settings.get/set/has/register/migrate` | `src/modules/**` | [ctx.get and ctx.set](./context-api.md#settings-access), or `m.settings` in [migrations](./define-module.md#migrations) |
| The `'ala_mod_'` prefix | `src/modules/**` | [ctx.storage](./context-api.md#storage), or `m.storage` in migrations |
| Importing the `AniList` singleton from `api/anilist` | `src/modules/**` | [ctx.api](./platform-apis.md#anilist-api-client) |
| Raw `GM_*` APIs | `src/modules/**` | `ctx.http`, `ctx.storage`, `ctx.menuCommand`, see [Context API](./context-api.md) |
| `persistent` from `utils/helpers` | `src/modules/**` | [ctx.persistent](./context-api.md#persistent-caches) |
| `store`, `jsonGet`, `jsonSet` from `utils/helpers` | `src/modules/**` | [ctx.storage](./context-api.md#storage) |
| `gm` or `downloadFile` from `utils/helpers` | `src/modules/**` | [ctx.http](./context-api.md#networking) |
| `localStorage` or `sessionStorage` | `src/modules/**` | [ctx.storage](./context-api.md#storage), or `m.legacy.getLocal` and `delLocal` in migrations |
| `window.addEventListener` or `document.addEventListener` | `src/modules/**` | [ctx.listen or rc.listen](./context-api.md#timers-and-listeners) |
| `ctx.debug`, `logDebug`, `isDebug`, `registerDebugChannel`, `createCoreLogger`, `createLogger`, `isDebugEnabled`, `getDebuggableChannels` | `src/modules/**` | [ctx.log](./context-api.md#logging) |
| Raw `console.log`, `debug`, `warn`, `error` | `core/`, `settings/`, `api/`, `modules/` | `ctx.log` in modules, [createCoreLogger](./platform-apis.md#core-logging) elsewhere |
| A `migrate` hook or helper without a valid `@migration(...)` tag | `src/**` | Add `// @migration(from: "...", kind: "...", sunset: "...")` (`kind` is `storage`, `import`, or `cleanup`), see [Migrations](./define-module.md#migrations) |

Only `window.addEventListener` and `document.addEventListener` are blocked. Listeners on elements you create (`button.addEventListener(...)`) are fine.

To run just this guard while fixing violations, see [Architecture and Convention Guards](./testing.md#architecture-and-convention-guards).
