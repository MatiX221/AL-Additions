# Module Definition

`defineModule(...)` from `src/core/registry.ts` is the only way a feature module registers itself. This reference documents every field of that call. For a gentle introduction, start with [Getting Started](./getting-started.md).

Calling `defineModule` registers the module's settings and schema. It does not run the feature. The kernel decides later, based on the saved toggle, host, dependencies, and standalone checks, whether to call `setup(ctx)`.

```ts
defineModule({
  id: 'example',
  key: 'exampleEnabled',
  section: 'AniList Enhancements',
  title: 'Example',
  help: 'What this module does.',
  layer: 'feature',
  requiresReload: false,
  hosts: ['anilist.co'],
  dependsOn: [],
  after: [],
  options: [],
  debug: { label: 'Example', title: 'Example Debug', help: 'Log example events.' },
  migrate(m) {},
  setup(ctx) {}
});
```

Only `id`, `key`, `title`, `help`, and `setup` are required.

---

## Identity and Settings Card

| Field | Purpose |
| :--- | :--- |
| `id` | Unique module identifier. Must match `/^[a-z][A-Za-z0-9]*$/`. |
| `key` | Setting key for the on/off toggle, stored as `ala_setting_<key>`. |
| `legacy` | Older names for the toggle key, used once by the settings migration. |
| `section` | Settings panel group. Defaults to `Other`. |
| `title`, `help` | Text on the toggle card. |
| `accounts` | Account providers the module may use through `ctx.accounts`. Enforced. |

**`id`** namespaces everything the module owns: scoped storage (`ala_mod_<id>_*`, see [Storage](./context-api.md#storage)), debug settings, and published services (see [Services](./communication.md#services)). An invalid id is rejected with status `invalid-id`. A second module with the same id is ignored and both are marked `id-collision`.

**`key`** must be unique across every setting in the script. A duplicate throws `Duplicate setting: <key>` at load time, before any module runs. The toggle always defaults to `false`; registering a toggle with another default throws. This keeps every feature opt-in.

**`legacy`** lists earlier setting names. On startup, if the new key has never been saved, the settings migration looks for each legacy name (first in userscript storage under `ala_setting_<name>`, then in `localStorage` under `ALAdditions:<name>`) and copies the first value it finds. Use this when you rename a setting. For anything more complex, use [Migrations](#migrations).

**`section`** picks the collapsible group in the Settings panel. `Sync` and `General` are pinned first, `Advanced` is pinned last, and every other section is sorted alphabetically. Cards inside a section are sorted by title.

**`title` and `help`** are inserted into the panel as HTML, so simple markup such as `<b>` works. Escape anything dynamic.

**`accounts`** lists the account provider ids (for example `['mal']`) the module may use through `ctx.accounts`. It is enforced by both the compiler and the runtime:

- `ctx.accounts.isConnected('other')` is a type error when `'other'` is not declared. Write the list as an inline array literal so the ids are inferred as literal types.
- A call that gets past the compiler throws `Module "<id>" cannot access account provider "<provider>" without declaring it in accounts`.
- `ctx.accounts.clearSecrets()` with no argument clears only the declared providers, never every provider in the script.
- `connect` and `disconnect` do nothing after the module has been disposed.

Helpers in sibling files type the context as `FeatureContext<true, 'mal'>`, where the second parameter is the union of declared ids. See [Using ctx From Sibling Files](./context-api.md#using-ctx-from-sibling-files) and [Accounts](./platform-apis.md#accounts).

---

## Execution Layers

`layer` decides when a module boots. The kernel runs the early phase once at `document-start` and the deferred phase when `document.body` exists.

| Layer | Phase | Use it for |
| :--- | :--- | :--- |
| `intercept` | Early | Patching `fetch`, `Worker`, or page globals before AniList starts. |
| `preload` | Early | Work that must happen before the page paints, such as URL rewrites or RPC blockers. |
| `service` | Deferred | Background services and shared providers other modules depend on. |
| `feature` | Deferred | Default. Page widgets and DOM enhancements. |

The `shell` layer exists only for the Settings panel and cannot be chosen in `defineModule`. The full boot order and the reasoning behind it are in [Five-Layer Boot Model](./architecture.md#five-layer-boot-model).

Rules to remember:

- In the early phase `document.body` can be `null`. Use `ctx.ready(...)` for anything that needs the DOM.
- Within one layer, modules are ordered by [dependencies](#dependencies), then alphabetically by `id`.
- A module may only depend on modules in the same or an earlier layer. A dependency in a later layer produces status `layer-conflict`.

---

## Hot-Reload vs. Page Reload

`requiresReload` tells the Settings panel what to do when a user saves a change that affects your module. It defaults to `false`.

| Value | What Save does |
| :--- | :--- |
| `false` | The kernel disposes the module and runs `setup(ctx)` again. No tab refresh. |
| `true` | The button reads **Save and reload** and the page refreshes after saving. |

The panel considers a module affected when its active state flips, or when it is (or was) active and one of its own options changed.

Use `requiresReload: true` when the module cannot undo its effects, for example when it patches `window.fetch` or `Worker`, runs at `document-start`, or rewrites state that the page reads only once. Everything that can be fully removed by its cleanups should hot-reload.

Hot-reload is only as good as your cleanups. Anything you attach through `ctx` is removed for you (see [Lifecycle and Cleanup](./context-api.md#lifecycle-and-cleanup)). Anything you create by other means needs a `ctx.onCleanup(...)`.

---

## Host Filtering

`hosts` lists the hostnames where the module may run. It defaults to `['anilist.co']`. Use `'*'` to allow every host the script is injected on. Matching is an exact comparison against `location.hostname`.

On any other host the module's status is `host-mismatch` and `setup(ctx)` never runs. The Settings panel still lists the toggle and shows an "Only active on" note.

The userscript manager only injects the script on URLs listed in `userscript.match` in `vite.config.ts`, so a new host needs both an entry there and an entry in `hosts`. Code that runs on a different site must also avoid AniList-only assumptions such as AniList route patterns and selectors.

---

## Dependencies

| Field | Meaning |
| :--- | :--- |
| `dependsOn` | Hard requirement. The module only runs while every listed module is active. |
| `after` | Soft ordering. Boots later than the listed modules if they exist. |

Both take module ids.

A module whose dependency is off or broken is not started, and its status says why:

| Status | Cause |
| :--- | :--- |
| `dep-off` | A dependency is disabled by the user. The Settings toggle is locked and shows a note. |
| `dep-unavailable` | A dependency is missing, failed at runtime, paused for a standalone script, or on another host. |
| `cycle` | The module is part of a dependency cycle. |
| `layer-conflict` | A dependency is in a later [layer](#execution-layers). |

If a dependency stops later (disabled, hot-reloaded, or failed), its dependents are disposed first, in reverse dependency order, and restarted when it returns.

`after` never blocks a module. It is ignored if the target does not exist, is in another layer, or would create a cycle with a hard dependency.

To exchange data with a dependency without importing it, see [Inter-Module Communication](./communication.md).

---

## Child Options

`options` adds controls under the module's toggle card. They are only shown, and only enabled, while the module is on.

```ts
options: [
  {
    key: 'exampleInterval',
    type: 'number',
    def: 6,
    min: 1,
    max: 720,
    title: 'Interval',
    help: 'Hours between runs.'
  }
]
```

Read them with `ctx.get<T>(key)`. Values are normalized on every read, so invalid or missing saved data falls back to `def`. Modules cannot import `Settings`, so a helper in another file receives the value as an argument, see [Using ctx From Sibling Files](./context-api.md#using-ctx-from-sibling-files).

| Field | Notes |
| :--- | :--- |
| `key` | Unique across the whole script, like the main toggle. |
| `type` | `toggle`, `number`, `select`, `list`, or `json`. |
| `def` | Default value. Required. |
| `title`, `help` | Row text. HTML is allowed, so escape dynamic content. |
| `min`, `max` | Number bounds. Missing bounds default to 0 and 100, so set both explicitly. |
| `options` | For `select`: an array of `[value, label]` pairs. |
| `legacy` | Older names for this key, migrated like the main toggle. |
| `validate` | For `json`: custom validation, see below. |
| `childOf` | Key of a `toggle` option in the same module that gates this row. |
| `editor` | For `json`: the function that opens the editor UI. |

### Option types

| Type | Stored as | Behavior |
| :--- | :--- | :--- |
| `toggle` | boolean | `'false'` and falsy values read as `false`. Option toggles may default to `true`. |
| `number` | integer | Rounded, then clamped to `min` and `max`. Non-numeric input falls back to `def`. |
| `select` | string | Must equal one of the `options` values, otherwise `def`. |
| `list` | string array | Edited as comma-separated text. Items are trimmed, empties dropped, and an empty result falls back to `def`. |
| `json` | any JSON | Edited through your `editor` function. Invalid data falls back to a clone of `def`. |

### Nested options with childOf

`childOf` collapses a row under a parent toggle and disables it while the parent is off:

```ts
options: [
  { key: 'autoSync', type: 'toggle', def: false, title: 'Auto Sync', help: '...' },
  { key: 'autoSyncHours', type: 'number', childOf: 'autoSync', def: 6, min: 1, max: 720, title: 'Interval', help: '...' }
]
```

### JSON options

A `json` option shows a **Customize** button that calls `editor(ctx)`. The editor receives a `JsonEditorContext` with `value` (the staged value), `onApply(next)`, `addStyle`, `listen`, an optional `api` (the AniList client), and an optional `log`. Use `listen` instead of `document.addEventListener`, which modules cannot call. Styles and listeners created through it are removed when the Settings panel closes. Edits are staged in the panel and only saved when the user presses Save. `validate(value)` may return a boolean or an object such as `{ valid: true, config }`. When it returns an object, the value used is the first of `value`, `tiers`, `config`, or `overrides` that is present, otherwise the original input. A throwing validator is treated as invalid.

For a complete editor, see [Staged JSON Modal Editors](./recipes.md#staged-json-modal-editors).

---

## Debug Logging

`debug` controls what `ctx.log` can do. It is also what makes the module appear under Advanced, then Developer Mode in the Settings panel. The logger API is documented in [Logging](./context-api.md#logging).

There are four shapes:

| `debug` value | Result |
| :--- | :--- |
| omitted | `ctx.log.warn` and `ctx.log.error` only. `ctx.log.debug` is a compile-time error. No settings entry. |
| `{ debug: false, label?, channels? }` | Same, with a custom console prefix. Channels must also be `debug: false`. |
| `{ label?, title, help }` | One Developer Mode toggle that enables `ctx.log.debug`. |
| `{ label?, title, help, channels }` | A master toggle, a **General** toggle, and one toggle per channel declared with `debug: true`. |

```ts
debug: {
  label: 'Fast Load',
  title: 'Fast Load Debug',
  help: 'Log cache hits and prefetching.',
  channels: {
    rpc: { label: 'RPC', title: 'Worker RPC', help: 'Log worker traffic.', debug: true },
    quiet: { label: 'Quiet', debug: false }
  }
}
```

Details:

- The console prefix is `[label]`, falling back to the module title. Channel output is prefixed `[label (channelLabel)]`.
- `general` is reserved for the automatic General toggle. Declaring a channel with that name throws at load time.
- `ctx.log.channel('rpc')` is type-checked against the declared channels. At runtime an undeclared name returns a silent logger.
- Debug output prints only when Developer Mode is on, the module's master toggle is on, and the channel toggle (if any) is on. Setting `window.__ALA_DEBUG__ = true` in DevTools forces everything on.
- Turning Developer Mode off hides output without deleting the saved per-module choices.

---

## Standalone Conflict Yielding

Some features began as separate userscripts. If the user still has the standalone copy installed, two copies would fight over the same page. `standalone` lets a built-in module step aside.

```ts
standalone: {
  name: 'Other Script Name',
  probe: () => document.documentElement.hasAttribute('data-other-script'),
  note: 'Optional extra text for the Settings note.'
}
```

When a probe returns `true` the module's status becomes `standalone-paused`: its cleanups run, dependents are paused, the toggle is locked, and the panel explains why. The saved setting is kept and applies again once the standalone script is removed.

The kernel probes when the Settings panel opens. A module can also pause itself during startup with `ctx.setStandalonePaused(true)`, which is how a module reacts to a conflict it finds in `setup(ctx)`. The full pattern, including remembering the last probe result so normal page loads never wait, is in [Yielding to Standalone Scripts](./recipes.md#yielding-to-standalone-scripts).

---

## Migrations

`migrate(m)` upgrades stored data from an older version of the script. It exists so that `setup(ctx)` can assume current formats.

Timing and guarantees:

- Migrations run once per page load, after `Settings.migrate()` and before any module starts.
- They run for every valid module, including disabled ones, ordered by layer and then `id`.
- A throwing migration is logged and skipped. It never stops other modules.
- Migrations run on every load, so they must be **idempotent**. Guard each step with a schema number or a check that the old data still exists.

The `m` object (`MigrateContext`):

| Member | Purpose |
| :--- | :--- |
| `m.id` | The module id. |
| `m.storage` | Scoped storage (`ala_mod_<id>_*`), same shape as [ctx.storage](./context-api.md#storage). |
| `m.settings` | `has(key)`, `get(key)`, `set(key, value)` for registered settings. |
| `m.legacy` | `get`, `set`, `del` on raw, unscoped userscript storage keys, plus `getLocal(key)` and `delLocal(key)` for `localStorage`. The only sanctioned way to touch old key names. Modules cannot use `localStorage` anywhere else. |

Writes through `m` are ignored after the hook returns, so do not keep references for later.

### The @migration annotation

Every file that defines a `migrate` hook or a helper named `migrate...` must contain at least one valid annotation comment, and every `@migration` comment anywhere in `src/` must be well formed. Double quotes are required:

```ts
// @migration(from: "v0.9.1", kind: "storage", sunset: "2-3 releases")
```

| Part | Meaning |
| :--- | :--- |
| `from` | The version that introduced the new format. |
| `kind` | `storage` (moves or reshapes data), `import` (reads another source), or `cleanup` (deletes obsolete data). |
| `sunset` | When it can be removed, such as `2-3 releases` or `keep-long`. |

`conventions.test.ts` enforces this. See [Architecture and Convention Guards](./testing.md#architecture-and-convention-guards). A worked example is in [Writing Migrations](./recipes.md#writing-migrations).

---

## Setup and Failure Handling

`setup(ctx)` may be synchronous or return a promise. The kernel runs it once per boot and tracks its cleanups.

- A throw or rejection marks the module `error`, runs its cleanups, disposes dependents, and shows an **Error** badge in Settings with the message.
- Cleanups run in reverse order of registration. A throwing cleanup is logged and the rest still run.
- If the module is reloaded or disabled while an async `setup` is still pending, the late result is discarded and its cleanups run.
- After disposal, lifecycle hooks, DOM mounts, timers, HTTP requests, `ctx.storage` writes, account connection changes, and event or hook mutations become no-ops or abort, so stray callbacks cannot revive the module.

### Status reasons

`host.getStatus(id)` (used by the Settings panel and tests) returns one of these.

| `reason` | Meaning |
| :--- | :--- |
| none (`active: true`) | Running. |
| `disabled` | The toggle is off. |
| `invalid-id` | The id failed the pattern check. |
| `id-collision` | Two modules used the same id. |
| `host-mismatch` | Wrong site, see [Host Filtering](#host-filtering). |
| `standalone-paused` | Yielding to a standalone script. |
| `dep-off`, `dep-unavailable`, `cycle`, `layer-conflict` | See [Dependencies](#dependencies). |
| `error` | `setup` threw or rejected. |
