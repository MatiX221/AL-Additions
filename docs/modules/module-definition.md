# Module Definition (`defineModule`)

Calling `defineModule(meta)` registers both the module's persisted settings schema (in `Settings`) and its runtime lifecycle record (in the kernel registry).

```ts
import { defineModule } from '../../core/registry';
```

---

## Complete Schema Reference

```ts
export interface ModuleMeta<
  TId extends string = string,
  TDebug extends ModuleDebugDef<any> | undefined = undefined
> {
  id: TId;
  key: string;
  legacy?: string[];
  section?: string;
  title: string;
  help: string;
  layer?: 'intercept' | 'preload' | 'service' | 'feature';
  requiresReload?: boolean;
  hosts?: string[];
  dependsOn?: string[];
  after?: string[];
  accounts?: string[];
  options?: SettingOption[];
  debug?: TDebug;
  standalone?: ModuleStandaloneDef;
  migrate?: (m: MigrateContext) => void;
  setup: (
    ctx: ScopedFeatureContext<TId, CanModuleDebug<TDebug>, ModuleChannels<TDebug>>
  ) => void | Promise<void>;
}
```

`ScopedFeatureContext` scopes `ctx.services.provide(localName, impl)` to keys registered under `${id}:*` in `ServiceMap` and types `ctx.log` / `ctx.log.channel(...)` from your literal `debug` definition (blocking `.debug()` and undeclared channels at compile time). Contexts with `debug` enabled are assignable to `FeatureContext<true>` and `FeatureContext`.

---

## Identity & Settings Card Metadata

### `id` (required)
- Unique module identifier matching `/^[a-z][A-Za-z0-9]*$/` (letters and digits only, starting with a lowercase letter).
- Invalid IDs receive status `'invalid-id'` and fail registration without mutating settings or booting. Duplicate IDs trigger `'id-collision'` on the existing record.
- Used as the namespace for:
  - Module-scoped storage (`ctx.storage` prefixes keys with `ala_mod_<id>_`).
  - Published services (`ctx.services.provide('quickEdit', fn)` publishes `'manualOverrides:quickEdit'`).
  - Consolidated debug configuration scope (`debug[id]` inside `ala_setting_debug`).

### `key` (required)
- Setting name stored in Tampermonkey storage under `ala_setting_<key>`.
- Every module's main toggle always defaults to `false` (strictly opt-in on fresh installs); `defineModule` enforces this automatically, so no `def` property exists on `ModuleMeta`.
- `legacy`: Optional array of older unprefixed or renamed setting keys. During `Settings.migrate()`, the first found value across `legacy` (in GM storage or `ALAdditions:<name>` in `localStorage`) is automatically copied to `ala_setting_<key>`.

### `section`, `title`, and `help`
- Controls how the module card renders inside the Settings panel:
  - **`Sync`** and **`General`** sections are always pinned at the top; **`Advanced`** (which hosts Core **Developer Mode**) is always pinned at the bottom.
  - Any other `section` name (e.g. `'AniList Enhancements'`, `'External Links, Downloads & Mappings'`, or a custom section) is automatically discovered and sorted alphabetically between `General` and `Advanced`.
  - Modules within each section are sorted alphabetically by `title` (tie-broken by `id`).

---

## Execution Layer (`layer`)

Choose the earliest layer your module strictly requires:

| Layer | Phase | Runs When | Intended Use Cases |
| :--- | :--- | :--- | :--- |
| `'intercept'` | Early (`document-start`) | Synchronously on script evaluation before AniList executes. | Patching `window.fetch`, `Worker.prototype.postMessage`, page globals, or XHR before AniList initializes. |
| `'preload'` | Early (`document-start`) | Synchronously on script evaluation after `'intercept'`. | Early route/title guards, RPC request blockers, pre-paint setup where `document.body` may still be `null`. |
| `'service'` | Deferred (`DOM ready`) | After `DOMContentLoaded` (or immediately if body exists). | Background synchronization, OAuth watchers, shared service providers (`ctx.services.provide`). |
| `'feature'` | Deferred (`DOM ready`) | After `DOMContentLoaded`, once `'service'` modules have initialized. | Default layer. DOM widgets, page buttons, tooltips, injected sections. |

> **Early Layer Caution (`intercept` and `preload`):**
> `document.body` can be `null` when `setup(ctx)` runs. Never access `document.body` synchronously at the top of `setup(ctx)` in `'intercept'` or `'preload'` modules. Instead, use `ctx.ready(...)`, `ctx.onNav(...)`, `ctx.onBodyMutation(...)`, or guard `if (document.body)` safely.

---

## Hot-Reloading vs. Full Page Reload (`requiresReload`)

Controls what the Settings panel does when the user modifies this module or its active options:

- **`requiresReload: false` (recommended when achievable):**
  Settings displays **Save** and calls `ModuleHost.reload(changedIds)`. Your previous instance runs all registered cleanups in reverse order, and if still active, `setup(ctx)` runs again with the new config with zero page refresh required.
- **`requiresReload: true`:**
  Use this whenever disabling or reconfiguring the module cannot be cleanly undone live (e.g., prototype patches installed before AniList boots, worker intercepts, heavy DOM rewrites that leave native scrollers destroyed).
  Whenever a `requiresReload: true` module transitions effective active state (including indirectly via a `dependsOn` parent toggle!) or has an option changed while active, the Settings button automatically switches from **Save** to **Save and reload** and reloads the tab on Save.

---

## Host Filtering (`hosts`)

- Defaults to `['anilist.co']`.
- Supports `'*'` (runs on every matched site) or exact hostnames (e.g. `['anilist.co', 'myanimelist.net']`).
- If the current `location.hostname` does not match `hosts`:
  - `setup(ctx)` does **not** run on this host; `getStatus(id)` returns `{ active: false, reason: 'host-mismatch' }`.
  - In Settings, `'host-mismatch'` toggles **remain editable** and display an inline host notice (`Only active on: ...`) so users on AniList can still configure modules meant for external hosts.

---

## Dependency Graph (`dependsOn` and `after`)

### `dependsOn: string[]` (Hard Dependencies)
Declares modules that **must** be active for this module to run:
- Dependency targets must belong to an **earlier or equal** `layer` (e.g. a `'feature'` may depend on a `'service'` or `'feature'`, whereas a `'service'` depending on a `'feature'` is rejected with `'layer-conflict'`).
- Circular `dependsOn` graphs resolve cleanly with `'cycle'` status rather than hanging.
- Missing or host-mismatched dependencies put this module in `'dep-unavailable'`.
- Disabled dependencies put this module in `'dep-off'`.
- **Settings UI behavior:** Locked cleanly and **non-destructively** (`disabled = true` while keeping the user's saved `checked` value intact, collapsing child options/debug toggles, and rendering a `Requires <Title> to be enabled.` note). Turning the parent dependency back on unlocks the child automatically with its toggle state preserved.
- **Hot-reload cascading:** Disabling or reloading a parent dependency automatically tears down its active dependents in reverse topological order (`child` -> `parent`) before rebooting!

### `after: string[]` (Soft Ordering)
Suggests booting after another module if that module happens to be active, **without** failing if the target is missing or disabled. Soft-ordering cycles break deterministically by alphabetical `id`.

---

## Child Options (`options`)

Child settings render indented below the module's main toggle card, collapsing automatically whenever the module is disabled.

```ts
export interface SettingOption {
  key: string;
  type: 'toggle' | 'number' | 'select' | 'list' | 'json';
  def: any;
  title: string;
  help: string;
  min?: number;                 // 'number' only
  max?: number;                 // 'number' only
  options?: [string, string][]; // 'select' only: [storedValue, displayLabel]
  legacy?: string[];
  childOf?: string;             // Key of a parent 'toggle' option in the same module
  validate?: (raw: unknown) =>
    | boolean
    | { valid: boolean; value?: any; tiers?: any; config?: any; overrides?: any; error?: string };
  editor?: (ctx: JsonEditorContext) => void; // 'json' only
}
```

### Supported Types & Normalization

1. **`'toggle'`**: Stores a boolean (normalizes boolean values and string `'false'` -> `false`). Child options may default to `false` or `true`; a module's main toggle always defaults to `false`.
2. **`'number'`**: Rounds to integer and clamps between `[min, max]`. Falls back to `def` on `null`/`NaN`.
3. **`'select'`**: Validates stored value against `options` tuples `[value, label]`; falls back to `def` if unrecognized.
4. **`'list'`**: Stores `string[]`; renders as comma-separated `<input type="text">` in Settings, trimming whitespace and dropping empty items automatically.
5. **`'json'`**: Stores structured objects/arrays; renders a hidden `<input>` + **Customize** button that invokes `editor(ctx)` if provided (see [Platform APIs: Custom JSON Sub-Modals](./platform-apis.md#custom-json-sub-modal-editors)).
   - When `validate(val)` returns `{ valid: false }`, normalization falls back to `def`.
   - When `validate(val)` returns `{ valid: true, value | tiers | config | overrides }`, normalization stores the cleaned object returned by your validator.

### Nesting with `childOf`
Set `childOf: 'someToggleOptionKey'` on a secondary option (such as an interval number tied to an Auto-Sync toggle) to collapse/disable it unless both the module and `someToggleOptionKey` are enabled.

### Atomic Registration
`Settings.register` validates every key (`[toggle, ...options]`) and reserved debug channel names (rejecting `'general'` case-insensitively) before committing anything to `ROWS` or `features`. Any collision throws immediately and rolls back atomically with zero partial keys left behind.

---

## Debug Logging (`debug`)

Modules support three `debug` configurations:

1. **Omitted (`debug` not set):** `ctx.log.warn(...)` and `ctx.log.error(...)` prefix `[<title>]`, `ctx.log.debug(...)` is blocked at compile time, and nothing is added to Developer Mode.
2. **Warn/error custom prefix only (`debug: false`):** Customize `[Label]` and optional sub-channel prefixes for `.warn()`/`.error()` without adding dead toggles to Developer Mode:
   ```ts
   debug: {
     debug: false,
     label: 'AniSongs',
     channels: {
       audio: { label: 'Audio', debug: false }
     }
   }
   ```
3. **Debuggable (`debug?: true`):** Registers an entry under `debug[id]` in the consolidated `ala_setting_debug` JSON setting and renders inside **Advanced → Developer Mode** wrapped in `[data-debug-for="<toggleKey>"]`:
   ```ts
   debug: {
     label: 'Fast Load',         // optional console tag (defaults to meta.title)
     title: 'Fast Load Debug',
     help: 'Log GraphQL caching, prefetching, deduplication, and Web Worker RPC activity.',
     channels: {
       rpc: {
         label: 'RPC',
         title: 'Web Worker RPC',
         debug: true,
         help: 'Log Web Worker RPC requests, cache hits/misses, and prefetches.'
       }
     }
   }
   ```

- **Single toggle vs. 2-tier collapsible group:**
  - If a module declares zero `debug: true` channels, Developer Mode renders a single master toggle (`debug[id] = { enabled: false }`).
  - If a module declares one or more `debug: true` channels, Developer Mode renders a master toggle plus a collapsible child group containing **General** (`channels.general`, for `ctx.log.debug(...)`) and each `debug: true` channel (`channels.<chId>`, defaulting to `true`). The channel key `'general'` is reserved.
  - Channels with `debug: false` inside a debuggable module format `[Label (Sub)]` for `.warn()`/`.error()`, register no toggle, and block `.debug()` at compile time.
- **Non-destructive muting:** Turning **Developer Mode** off mutes all `.debug()` output cleanly without wiping your nested `debug` preferences.
- **Backup format:** All Core/Kernel (`debug.core`) and module debug preferences live together under a single `"debug"` object next to `"devModeEnabled"` in settings backups.

---

## Standalone Conflict Yielding (`standalone`)

If users might still have a legacy standalone script installed that duplicates your module:

```ts
standalone: {
  name: 'Standalone Script Name',
  probe: () => !!(window as any).__SOME_EXTERNAL_GLOBAL__,
  note?: 'Optional extra guidance shown in the Settings banner.'
}
```

- When `ModuleHost.probeStandalone(id)` resolves `true`, or when your module calls `ctx.setStandalonePaused(true)` (during `setup` or later at runtime):
  - The module and any already-booted `dependsOn` hard dependents are torn down in reverse dependency order (`cascadeDispose`) while keeping the paused module's `standalonePaused` flag set.
  - The module status transitions to `'standalone-paused'` cleanly (and hard dependents become `'dep-unavailable'`).
  - Any live open Settings panel automatically disables the toggle and displays the orange standalone notice banner while keeping the user's underlying preference intact until the external script is uninstalled.

---

## Migrations & Error Isolation

### `migrate?: (m: MigrateContext) => void`
- Runs during `runMigrations()` **after** `Settings.migrate()`, **even if your module is disabled**.
- Receives a scoped `MigrateContext` (`m`) so migrations never hardcode `'ala_mod_<id>_'` or `'ala_setting_'` prefixes:
  - `m.id`: Module ID.
  - `m.storage`: Module-scoped `StorageScope` (`get`, `set`, `del`, `watch`, `clear` under `ala_mod_<id>_`).
  - `m.settings`: `{ has(key), get(key), set(key, val) }` backed by `Settings`.
  - `m.legacy`: `{ get(key, def?), set(key, val), del(key) }` for reading and deleting pre-migration raw GM storage keys.
  - Writes via `m.storage` and `m.legacy` are automatically disabled once `migrate(m)` finishes.
- **Required `@migration` annotation:** Every `migrate` hook or migration helper must document its origin, kind (`storage`, `import`, or `cleanup`), and rough removal timeframe (enforced by `__tests__/conventions.test.ts`):
  ```ts
  migrate(m) {
    // @migration(from: "v0.9.1", kind: "storage", sunset: "2-3 releases")
    const oldVal = m.legacy.get('old_raw_key', null);
    if (oldVal !== null) {
      if (m.storage.get('new_key', null) === null) {
        m.storage.set('new_key', oldVal);
      }
      m.legacy.del('old_raw_key');
    }
  }
  ```

### Fault Isolation
If `migrate()`, synchronous `setup(ctx)`, asynchronous `setup(ctx)` rejection, or any individual `CleanupFn` throws:
- The kernel catches and logs the error cleanly.
- If `setup(ctx)` fails asynchronously after downstream `dependsOn` modules have already booted (and the failed attempt was not superseded by a newer reload), the kernel cascades cleanup across those booted dependents (`'dep-unavailable'`) so active UI does not remain attached to a failed dependency.
- Your module enters `{ active: false, reason: 'error', error: message }` (shown with an **Error** badge & note in Settings).
- Remaining unrelated modules across the current and later layers (including `shell`) continue booting normally, and sibling cleanup callbacks continue executing in reverse order.
