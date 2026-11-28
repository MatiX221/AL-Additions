# AL Additions Developer Documentation

AL Additions is a modular **microkernel** userscript for AniList and companion sites. Every user-facing feature lives in its own folder under `src/modules/` and interacts with AniList, storage, networking, settings, and sibling modules through a managed `FeatureContext` (`ctx`) rather than calling global userscript APIs or page internals directly.

---

## How Startup Works

When the userscript loads, `src/main.ts` wires core services and eagerly discovers every entrypoint matching `src/modules/*/index.ts`.

Importing a module file does **not** run the feature. It only registers the module's schema via `defineModule(...)`. From there, the kernel runs five stages:

1. **Migrations:** Runs `Settings.migrate()`, then each module's `migrate(m)` hook (even for disabled modules) so old storage formats stay up to date. See [Migrations](./define-module.md#migrations).
2. **Graph Resolution:** Evaluates each module's saved toggle, [host filter](./define-module.md#host-filtering), [standalone conflicts](./define-module.md#standalone-conflict-yielding), and [dependencies](./define-module.md#dependencies).
3. **Early Boot (`document-start`):** Boots active `intercept` modules, then `preload` modules, before AniList finishes initializing. See [Five-Layer Boot Model](./architecture.md#five-layer-boot-model).
4. **Deferred Boot (`DOM ready`):** Boots active `service` modules, then `feature` modules, and finally the `shell` layer (the Settings panel itself).
5. **Lifecycle Isolation:** Every active module receives its own `FeatureContext` (`ctx`) with `ctx.signal` that tracks styles, DOM mounts, modals, listeners, timers, HTTP requests, route watchers, services, and event subscriptions. When a module disables or hot-reloads, the kernel aborts `ctx.signal` and tears everything down in reverse registration order.

---

## Five Enforced Rules

`npm test` runs `__tests__/layering.test.ts` and `__tests__/conventions.test.ts` across `src/`. Keep these five rules in mind from the start:

1. **Zero import-time side effects:** Importing files under `src/modules/**`, `src/api/**`, or `src/settings/**` must not touch the DOM, inject CSS, call `GM_*`, start timers, rewrite history, fetch, or attach listeners. Put all runtime work inside `setup(ctx)` or `migrate(m)`. See [Zero Import-Time Side Effects](./architecture.md#zero-import-time-side-effects).
2. **Never import another module or core internals:** Modules may only import `types.ts`, `utils/*`, `api/*`, `core/registry.ts`, and their own sibling files. They never import `Settings`, another module, or other `core/*` files. See [Import DAG](./architecture.md#import-dag) and [Inter-Module Communication](./communication.md).
3. **Use `ctx` instead of raw globals and helpers:** Do not call `GM_*` APIs, read raw session or auth keys, hardcode `ala_setting_` or `ala_mod_` prefixes, touch `localStorage`, call `addEventListener` on `window`/`document`/`globalThis`/`unsafeWindow`, or import the storage, HTTP, `Settings`, and `AniList` helpers directly. Every one of these has a `ctx` equivalent. See [Enforced Conventions](./architecture.md#enforced-conventions).
4. **No raw `console.*`:** Feature modules log through [ctx.log](./context-api.md#logging). Core, settings, and API files log through [createCoreLogger](./platform-apis.md#core-logging).
5. **Annotate every migration:** Every `migrate(m)` hook or migration helper must carry an adjacent or in-body `@migration(...)` comment. See [Migrations](./define-module.md#migrations).

---

## Documentation Map

| Guide | Read this when you want to... |
| :--- | :--- |
| **[Getting Started](./getting-started.md)** | Build your first module step by step, from a 12-line skeleton to a tested feature. |
| **[Architecture & Guardrails](./architecture.md)** | Understand the 5-layer boot model, import DAG, and every rule enforced by tests. |
| **[Module Definition](./define-module.md)** | Configure `defineModule(...)`: layers, reload behavior, hosts, dependencies, options, accounts, debug channels, standalone yielding, and migrations. |
| **[Context API](./context-api.md)** | Look up `ctx.storage`, `ctx.persistent`, `ctx.onRoute`, route patterns, `ctx.mount`, `ctx.addStyle`, `ctx.modal`, timers, `ctx.http`, toasts, menu commands, and `ctx.log`. |
| **[Platform & Shared APIs](./platform-apis.md)** | Query AniList (`ctx.session`, `ctx.api`), use connected accounts (`ctx.accounts`), or reach the shared helpers in `utils/*` and `api/*`. |
| **[Inter-Module Communication](./communication.md)** | Expose or consume typed services (`ctx.services`), broadcast state (`ctx.events`), or tap into GraphQL and RPC pipelines (`ctx.hooks`). |
| **[Recipes & Patterns](./recipes.md)** | Copy proven patterns for staged JSON modal editors, external API calls, migrations, standalone-script yielding, and new account providers. |
| **[Testing & Verification](./testing.md)** | Write Vitest unit and lifecycle tests (`bootModuleForTest`), understand the architecture guards, and verify builds before committing. |
