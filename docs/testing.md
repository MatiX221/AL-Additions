# Testing & Verification

Tests run on Vitest with a browser-like DOM (jsdom) pointed at `https://anilist.co/`. This guide covers the test environment, patterns for testing modules, and what the two architecture guards check.

---

## The Test Environment

`__tests__/setup.ts` runs before every test file and provides:

- **Userscript APIs.** `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_listValues`, and the value-change listeners are backed by an in-memory map. `GM_xmlhttpRequest`, `GM_registerMenuCommand`, and `GM_download` are plain `vi.fn()` mocks that do nothing until you give them behavior. `unsafeWindow` is the window itself.
- **Browser extras.** Web Crypto, `Blob`, `CompressionStream`, and `DecompressionStream` from Node.
- **Core services.** The AniList client is already configured, so `ctx.api` and `ctx.session` work in lifecycle tests.
- **Clean state per test.** Before each test the storage map and value listeners are cleared and `document.body` and `document.head` are emptied. History, `location`, and `localStorage` are not reset, so set the URL yourself with `history.replaceState({}, '', '/anime/1')` and clean up anything you alter if later tests depend on it.

Tests are not modules, so they may import `Settings`, `bootModuleForTest`, and other internals freely. The module-only rules in [Enforced Conventions](./architecture.md#enforced-conventions) apply to `src/modules/**` only.

If you add a new `GM_*` permission to `vite.config.ts`, add a matching mock to `setup.ts`.

---

## Pure Helper Tests

Export pure functions from your module files (parsers, formatters, validators, reconcilers) and test them directly. They need no DOM, no settings, and no boot.

```ts
import { describe, it, expect } from 'vitest';
import { formatBadgeText } from '../src/modules/mediaIdBadge';

describe('formatBadgeText', () => {
  it('formats full and compact labels', () => {
    expect(formatBadgeText('anime', 16498, 'full')).toBe('ANIME #16498');
    expect(formatBadgeText('manga', 2, 'short')).toBe('#2');
  });
});
```

Importing the file registers the module, but registering has no side effects, see [Zero Import-Time Side Effects](./architecture.md#zero-import-time-side-effects).

Design helpers so they take their inputs as arguments instead of reading settings or globals. That is both what the conventions require and what makes this style of test possible, see [Using ctx From Sibling Files](./context-api.md#using-ctx-from-sibling-files).

---

## Lifecycle Tests

`bootModuleForTest(id)` runs the real `setup(ctx)` of an imported module, and `createModuleHost().reload([id])` re-evaluates it the way the Settings panel does.

```ts
import { describe, it, expect } from 'vitest';
import '../src/modules/example';
import { Settings } from '../src/settings/settings';
import { bootModuleForTest, createModuleHost } from '../src/core/registry';

describe('example module', () => {
  it('mounts on its page and cleans up when disabled', async () => {
    document.body.innerHTML = '<div class="overview"></div>';
    history.replaceState({}, '', '/anime/16498');
    Settings.set('exampleEnabled', true);

    await bootModuleForTest('example');
    expect(document.getElementById('ala-example')).not.toBeNull();

    Settings.set('exampleEnabled', false);
    createModuleHost().reload(['example']);
    expect(document.getElementById('ala-example')).toBeNull();
  });
});
```

Things to know:

- `bootModuleForTest` disposes any earlier instance, boots a fresh one, and does not check the enabled toggle. Still set the toggle, because `reload` decides what to stop from it.
- **Assert against the resolved element ids.** IDs passed to `ctx.getId(name)` / `mount({ id })` namespace to `ala-<moduleId>-<name>`, and 2-arg `addStyle(name, css)` appends `-style` unless already present (names already starting with `ala-` stay as written), see [Element IDs](./context-api.md#element-ids) and [Mounting DOM Elements](./context-api.md#mounting-dom-elements).
- `host.getStatus(id)` returns `{ active: true }` or `{ active: false, reason }` and is the way to assert on dependency, host, standalone, and error behavior, see [Status reasons](./define-module.md#status-reasons).
- `MountHandle.unmount()` detaches a mount early, and `disposeFeature(id)` from the registry stops a module and everything that depends on it.
- Module-level state in your files survives between tests in the same file. Reset it in cleanups, or call `vi.resetModules()` and import again for a fresh copy.

### Timers and mutations

Mount repair and body-mutation callbacks are batched for 50 ms. Use fake timers and flush promises first:

```ts
vi.useFakeTimers();
document.getElementById('ala-example')!.remove();
document.body.appendChild(document.createElement('span')); // any mutation
await Promise.resolve();
vi.advanceTimersByTime(60);
expect(document.getElementById('ala-example')).not.toBeNull();
vi.useRealTimers();
```

### Faking network and menu calls

- **HTTP.** Give the mocked `GM_xmlhttpRequest` an implementation that calls `onload` with a response object:

  ```ts
  vi.mocked(globalThis.GM_xmlhttpRequest).mockImplementation((opts: any) => {
    opts.onload?.({ status: 200, responseText: '{"ok":true}', responseHeaders: '' });
  });
  ```

  Return `{ abort: vi.fn() }` from the mock if the test unloads the module mid-request and you want to assert the abort.
- **AniList.** Replace `window.fetch` with a mock that returns `new Response(JSON.stringify({ data: ... }))`, and restore it afterwards. Responses are cached per entity, so use different ids or call `anilistApiClient.invalidate()` from `../src/api/anilist` between cases.
- **Menu commands.** Spy on the menu module rather than on `GM_registerMenuCommand`: `vi.spyOn(menu, 'registerMenuCommand')` after `import * as menu from '../src/core/menu'`.
- **Partial module mocks.** When mocking a module that other code imports from too, keep the real exports: `vi.mock('../src/api/mal', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/api/mal')>()), searchMalId: vi.fn() }))`.

### Testing logging

Debug output needs Developer Mode and the module's toggle:

```ts
const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
Settings.set('devModeEnabled', true);
Settings.set('debug', { example: { enabled: true } });
// ... trigger the code ...
expect(spy).toHaveBeenCalledWith('[Example]', 'message');
```

`warn` and `error` always print, so they need no setup. See [Debug Logging](./define-module.md#debug-logging).

---

## Testing Migrations

Put old-format data in place with the raw store, run migrations, and assert on the new locations. Then run them a second time to prove they are idempotent.

```ts
import { runMigrations } from '../src/core/registry';
import { store } from '../src/utils/helpers';

it('moves the old key once', () => {
  store.set('old_raw_key', 'from-old');

  runMigrations();
  expect(store.get('ala_mod_example_new_key', null)).toBe('from-old');
  expect(store.get('old_raw_key', null)).toBeNull();

  store.set('ala_mod_example_new_key', 'edited');
  store.set('old_raw_key', 'reappeared');
  runMigrations();
  expect(store.get('ala_mod_example_new_key', null)).toBe('edited');
});
```

Tests may spell out `ala_mod_<id>_` keys because they check what is really stored. Modules never do. Migrations run for modules whose toggle is off, so no setup is needed. If your migration touches `localStorage`, set values with `localStorage.setItem` and assert with `getItem`. For patterns see [Writing Migrations](./recipes.md#writing-migrations).

---

## Architecture and Convention Guards

Two test files scan the source tree. They run as part of `npm test`, so any violation fails the build.

### layering.test.ts

- **`src/types.ts` stays a leaf.** It imports nothing from `src/`.
- **Imports follow the DAG.** Every relative import in `src/` must be allowed by the table in [Import DAG](./architecture.md#import-dag). The test compares against an allowlist of known violations that is meant to stay empty, and it also fails if that list contains an entry that no longer applies, so fixed violations must be removed from it.
- **Zero import-time side effects.** The test imports every `src/modules/*/index.ts` one at a time, with a fresh module registry, and fails if the import calls any `GM_*` function, changes `document.head` or `document.body`, or calls `addEventListener` on `window` or `document`.

### conventions.test.ts

- **Module rules.** `src/modules/**` is scanned, with comments removed and strings kept. Each rule in [Enforced Conventions](./architecture.md#enforced-conventions) is a pattern, and a hit is reported as `<file>: <rule name>`. There are no per-file exceptions.
- **No raw console.** `console.log`, `debug`, `warn`, and `error` calls are rejected in `core/`, `settings/`, `api/`, and `modules/`.
- **Migration annotations.** Every `@migration(...)` comment must parse, with double-quoted `from` and `sunset` and a `kind` of `storage`, `import`, or `cleanup`. Every file that declares a `migrate` hook or a function whose name starts with `migrate` must carry at least one valid tag.

How to fix a failure:

1. Read the reported rule name. The replacement for each blocked pattern is in the **Use Instead** column of [Enforced Conventions](./architecture.md#enforced-conventions).
2. If the hit is inside a string or comment you wrote only for explanation, rewrite it. Strings are scanned, so a log message containing a blocked key still fails. Plain comments are ignored.
3. Run only the guard while iterating: `npx vitest run __tests__/conventions.test.ts`.

---

## Verification Pipeline

Run this before every commit:

```bash
npx tsc --noEmit && npm test && npm run build
```

| Step | What it catches |
| :--- | :--- |
| `npx tsc --noEmit` | Type errors, including `ctx.log.debug` without a `debug` block, undeclared channels, undeclared accounts, bad service and event names, and wrong `ServiceMap` or `EventMap` payloads. |
| `npm test` | Unit and lifecycle tests, plus the layering and convention guards. |
| `npm run build` | The userscript bundle builds, so imports resolve and the manifest in `vite.config.ts` is valid. |

Finally, load the built script in your userscript manager and check the module on a real AniList page with Developer Mode on. Tests cannot see the real page's markup, so a selector that matches in your test DOM may still miss on the live site.
