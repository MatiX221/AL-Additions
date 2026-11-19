# Module Definition (`defineModule`)

Calling `defineModule(meta)` registers both the module's persisted settings schema (in `Settings`) and its runtime lifecycle record (in the kernel registry).

```ts
import { defineModule } from '../../core/registry';
```

---

## Complete Schema Reference

```ts
export interface ModuleMeta {
  id: string;
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
  debug?: ModuleDebugDef;
  standalone?: ModuleStandaloneDef;
  migrate?: () => void;
  setup: (ctx: FeatureContext) => void | Promise<void>;
}
```

---

## Identity & Settings Card Metadata

### `id` (required)
- Unique module identifier matching `/^[a-z][A-Za-z0-9]*$/` (letters and digits only, starting with a lowercase letter).
- Invalid IDs receive status `'invalid-id'` and fail registration without mutating settings or booting. Duplicate IDs trigger `'id-collision'` on the existing record.
- Used as the namespace for:
  - Module-scoped storage (`ctx.storage` prefixes keys with `ala_mod_<id>_`).
  - Published services (`ctx.services.provide('quickEdit', fn)` publishes `'manualOverrides:quickEdit'`).
  - Default debug channel name (unless overridden by `debug.channel`).

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
`Settings.register` validates every key (`[toggle, ...options, debug]`) before committing any key to `ROWS` or `features`. A duplicate key anywhere in `options` or `debug` throws immediately and rolls back atomically with zero partial keys left behind.

---

## Debug Channel (`debug`)

```ts
debug: {
  key: 'debugMyMod',
  title: 'My Module Debug',
  help: 'Log verbose activity for My Module in the console.',
  channel?: 'myMod',          // defaults to module id
  pattern?: /^\[MYMOD/i       // optional tag matcher for standalone logDebug() calls
}
```

- Automatically registers `ala_setting_<debug.key>` (defaulting to `false`) and binds `ctx.debug` inside `setup(ctx)`.
- In Settings, appears inside **Advanced → Developer Mode**, automatically wrapped in `[data-debug-for="<toggleKey>"]` so it collapses whenever either **Developer Mode** or your module is toggled off.
- Turning **Developer Mode** off mutes all `ctx.debug.log(...)` output cleanly without wiping your individual module debug toggle preferences.

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

- When `ModuleHost.probeStandalone(id)` resolves `true`, or when your `setup(ctx)` calls `ctx.setStandalonePaused(true)` at runtime:
  - The module status transitions to `'standalone-paused'` cleanly.
  - Any live open Settings panel automatically disables the toggle and displays the orange standalone notice banner while keeping the user's underlying preference intact until the external script is uninstalled.

---

## Migrations & Error Isolation

### `migrate?: () => void`
- Runs during `runMigrations()` **after** `Settings.migrate()`, **even if your module is disabled**.
- Use `migrate()` for one-time data schema upgrades or inspecting legacy localStorage/store keys before modules boot.

### Fault Isolation
If `migrate()`, synchronous `setup(ctx)`, asynchronous `setup(ctx)` rejection, or any individual `CleanupFn` throws:
- The kernel catches and logs the error cleanly.
- Your module enters `{ active: false, reason: 'error', error: message }` (shown with an **Error** badge & note in Settings).
- Remaining modules across the current and later layers (including `shell`) continue booting normally, and sibling cleanup callbacks continue executing in reverse order.
