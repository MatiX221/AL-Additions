# AL Additions: Module Development Guide

AL Additions is structured as a modular **microkernel** userscript. Every user-facing feature, page enhancement, and background service lives as a self-contained module under `src/modules/` and integrates with AniList, settings, storage, networking, and sibling modules strictly through the runtime APIs documented here.

---

## How the System Works

At startup, `src/main.ts` wires core services and eagerly discovers every module entrypoint matching:

```
src/modules/*/index.ts
```

Importing a module file only **registers** its schema (`defineModule(...)`) into the registry and settings catalog. It does not touch the DOM, call `GM_*` APIs, register listeners, or inject CSS. The core kernel then:

1. Runs settings & module migrations (`Settings.migrate()` followed by each module's `migrate()` hook).
2. Resolves enabled status, host filters (`hosts`), standalone script conflicts (`standalone`), hard dependencies (`dependsOn`), and soft ordering hints (`after`).
3. Boots active modules strictly across 5 execution layers:
   - **`intercept`** (`document-start`): `fetch`, Web Worker, and DOM prototype hooks.
   - **`preload`** (`document-start`): lightweight early listeners, RPC blockers, title sanitizers.
   - **`service`** (`DOM ready`): stateful background sync, OAuth account consumers, shared services.
   - **`feature`** (`DOM ready`): visual page widgets and UI enhancements.
   - **`shell`** (`DOM ready`): core shell UI (the Settings modal itself).
4. Passes each active module an isolated **`FeatureContext` (`ctx`)** that tracks styles, DOM mounts, event listeners, timers, HTTP requests, route watchers, services, and event subscriptions, tearing them all down in reverse order if a module is disabled or hot-reloaded.

---

## Documentation Map

Read these guides in order if you are building a new module, or jump straight to a reference:

1. **[Getting Started](./modules/getting-started.md)**
   Step-by-step tutorial building a complete module from scratch: folder structure, `defineModule`, injecting CSS, reacting to AniList SPA navigation, reading child options, manifest (`vite.config.ts`) updates, and writing tests.

2. **[Module Definition & Settings (`defineModule`)](./modules/module-definition.md)**
   Full specification of `ModuleMeta`, boot layers, `requiresReload` hot-reloading vs full page reload, `hosts` matching, `dependsOn` / `after` dependency graphs, every `SettingOption` control type (`toggle`, `number`, `select`, `list`, `json`), validators, `debug` integration, `standalone` detection, and `migrate()`.

3. **[Context API (`FeatureContext` & `RouteContext`)](./modules/context-api.md)**
   Detailed reference and examples for every `ctx.*` tool: settings access, module-scoped `ctx.storage` vs lazy `ctx.persistent`, SPA routing (`ctx.onRoute`, `AbortSignal`, `RouteContext`), declarative auto-repairing DOM mounts (`ctx.mount`), mutation observation (`ctx.ownUi`, `ctx.silently`, `ctx.onBodyMutation`), timers/listeners, `ctx.http`, toasts, Tampermonkey menu commands, and debugging logs.

4. **[Platform & Shared APIs](./modules/platform-apis.md)**
   How modules query AniList (`ctx.api` GraphQL client, `MediaData` cache, user list fetching, rate limiting, and mutations), manage connected OAuth accounts (`ctx.accounts`), locate AniList UI anchors and parse routes (`src/utils/anilistDom.ts`), use general utilities (`src/utils/helpers.ts`, `dom.ts`, `limiter.ts`), and build staged JSON sub-modal editors (`JsonEditorContext`).

5. **[Architecture, Communication & Testing](./modules/architecture-and-communication.md)**
   Import layering boundaries (DAG), publishing and consuming inter-module services (`ctx.services`), event broadcasts (`ctx.events`), low-level `fetch`/worker hooks (`ctx.hooks`), and writing isolated Vitest unit/DOM tests cleanly.
