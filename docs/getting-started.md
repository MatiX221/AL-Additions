# Getting Started: Build a Module Step by Step

In this tutorial you will build a small module called **Media ID Badge** (`src/modules/mediaIdBadge/index.ts`) that shows an anime or manga's numeric AniList ID in the sidebar.

We start with the smallest valid module and add one capability per step: SPA routing, a self-repairing DOM mount, a user option, live hot-reload, structured logging, and tests. Each step explains only what you need at that moment and links to the reference page with the full details.

---

## Step 1: Create the Minimal Module

Every module lives in its own folder under `src/modules/<folderName>/` with an `index.ts` entrypoint. You do not import it from `src/main.ts`: Vite discovers every `src/modules/*/index.ts` automatically.

Create `src/modules/mediaIdBadge/index.ts`:

```ts
import { defineModule } from '../../core/registry';

defineModule({
  id: 'mediaIdBadge',
  key: 'mediaIdBadgeEnabled',
  section: 'AniList Enhancements',
  title: 'Media ID Badge',
  help: 'Show the numeric AniList media ID in the sidebar on anime and manga pages.',
  setup(ctx) {
    // Runs only while the user has this module enabled in Settings.
  }
});
```

What each field does:

- `id`: unique camelCase identifier. The kernel uses it to namespace your storage (`ala_mod_mediaIdBadge_*`) and your debug settings. Rules are in [Identity and Settings Card](./define-module.md#identity-and-settings-card).
- `key`: the setting that stores the on/off toggle (`ala_setting_mediaIdBadgeEnabled`). Every module is off by default on a fresh install, so you never pass a default for it.
- `section`, `title`, `help`: where and how the toggle card appears in the Settings panel.
- `setup(ctx)`: your runtime entry point. Top-level code runs even when the module is disabled, so never touch the DOM, attach listeners, or call `GM_*` outside `setup(ctx)`. See [Zero Import-Time Side Effects](./architecture.md#zero-import-time-side-effects).

Omitted fields take safe defaults: `layer: 'feature'` (boots after DOM ready), `hosts: ['anilist.co']`, and `requiresReload: false` (toggled live, no tab refresh). Every field is documented in [Module Definition](./define-module.md).

---

## Step 2: React to AniList Page Navigation

AniList is a single-page application. Moving from `/anime/1` to `/anime/20` changes the URL without reloading the document, so DOM code that runs once in `setup(ctx)` would miss every later page.

Use `ctx.onRoute(...)` with a pattern for the pages you care about. The capture groups come back in `rc.match`:

```ts
import { defineModule } from '../../core/registry';

defineModule({
  id: 'mediaIdBadge',
  key: 'mediaIdBadgeEnabled',
  section: 'AniList Enhancements',
  title: 'Media ID Badge',
  help: 'Show the numeric AniList media ID in the sidebar on anime and manga pages.',
  setup(ctx) {
    ctx.onRoute(/^\/(anime|manga)\/(\d+)(?:\/|$)/, (rc) => {
      const kind = rc.match![1] as 'anime' | 'manga';
      const id = Number(rc.match![2]);

      // kind is 'anime' or 'manga', id is the numeric AniList media ID
    });
  }
});
```

Why `ctx.onRoute` instead of listening to `popstate` yourself:

- It runs immediately if the user is already on a matching URL when `setup(ctx)` runs, and again on every URL change.
- Each run receives a fresh route context (`rc`). Anything you attach through `rc` (mounts, listeners, timers, `rc.onCleanup` callbacks, `rc.signal`) is torn down the moment the user navigates or the module is disabled.

There is no shared route-parser or selector module. Each module keeps its own pattern and selector constants. Ready-made patterns for the common AniList pages are in [Route Patterns](./context-api.md#route-patterns), and every `rc.*` member is in [Routing](./context-api.md#routing).

---

## Step 3: Inject Scoped CSS and Mount into the DOM

Calling `appendChild` directly is fragile on AniList. The sidebar often renders after the route changes, and a later Vue re-render can drop your node.

`rc.mount(...)` handles this. It waits for the anchor to exist, injects optional scoped CSS before paint, inserts your element, re-inserts it if the page removes it, and removes both when the route changes or the module unloads. You can also allocate automatic stylesheet ids with 1-arg `ctx.addStyle(...)` or element ids with `ctx.getId(...)`:

```ts
import { defineModule } from '../../core/registry';

const SIDEBAR_DATA = '.sidebar > .data';

defineModule({
  id: 'mediaIdBadge',
  key: 'mediaIdBadgeEnabled',
  section: 'AniList Enhancements',
  title: 'Media ID Badge',
  help: 'Show the numeric AniList media ID in the sidebar on anime and manga pages.',
  setup(ctx) {
    const badgeId = ctx.getId('badge');

    ctx.onRoute(/^\/(anime|manga)\/(\d+)(?:\/|$)/, (rc) => {
      const kind = rc.match![1];
      const id = rc.match![2];

      rc.mount({
        id: badgeId,
        anchor: SIDEBAR_DATA,
        position: 'beforebegin',
        ownUi: true,
        style: (sel) => `${sel} {
          margin-bottom: 12px;
          padding: 10px 14px;
          border-radius: 3px;
          background: rgb(var(--color-foreground));
          color: rgb(var(--color-text));
          font-size: 1.3rem;
          font-weight: 600;
        }`,
        create: () => {
          const el = document.createElement('div');
          el.textContent = `${kind.toUpperCase()} #${id}`;
          return el;
        }
      });
    });
  }
});
```

Four things worth knowing here:

- **Automatic cleanup:** `rc.mount` registers cleanups for both the element and its `style`, so leaving the page or disabling the module removes the badge and its `<style>` tag immediately.
- **Repeated `create()` calls:** the mount is re-checked after page mutations, so `create()` can run again if the page drops your element. Keep it cheap and free of side effects.
- **`ownUi: true`:** tells the shared DOM observer to ignore mutations inside the badge, so updating your own UI never wakes your own `ctx.onBodyMutation` callbacks. It is opt-in.
- **Namespaced IDs:** `ctx.getId('badge')` resolves to `ala-mediaIdBadge-badge` (or pass `id: 'badge'` directly to `rc.mount`), and `mount` assigns that id on `el` and passes `#ala-mediaIdBadge-badge` to `style(sel)`. Never pass hardcoded `'ala-'`, `'daiya-'`, or `'almal-'` string literals to `addStyle` or `mount({ id })`.

Full details are in [Element IDs](./context-api.md#element-ids), [Mounting DOM Elements](./context-api.md#mounting-dom-elements), [Styles](./context-api.md#styles), and [Observer Exclusions](./context-api.md#observer-exclusions).

---

## Step 4: Add a User Option and a Pure Helper

Now let the user pick between a full label (`ANIME #16498`) and a compact one (`#16498`). Two habits help here:

- Export pure logic at the top level (`formatBadgeText`) so tests can call it without any DOM or settings setup. A plain exported function is not an import-time side effect.
- Declare options inside `defineModule` and read them with `ctx.get<T>(key)`. Modules cannot import `Settings` directly, and the convention tests reject it (see [Enforced Conventions](./architecture.md#enforced-conventions)). When a helper needs a setting, pass the value in as an argument.

```ts
export function formatBadgeText(kind: string, id: number | string, format: string): string {
  return format === 'short' ? `#${id}` : `${kind.toUpperCase()} #${id}`;
}
```

Add an `options` array to `defineModule(...)`:

```ts
  options: [
    {
      key: 'mediaIdBadgeFormat',
      type: 'select',
      def: 'full',
      options: [
        ['full', 'Full (ANIME #16498)'],
        ['short', 'Compact (#16498)']
      ],
      title: 'Display Format',
      help: 'Choose how the media ID is formatted.'
    }
  ],
```

Then read it inside the route handler and use the helper:

```ts
const format = ctx.get<string>('mediaIdBadgeFormat');
// ...
el.textContent = formatBadgeText(kind, id, format);
```

How hot-reload works here:

- Because `requiresReload` is `false`, changing Display Format and pressing Save does not refresh the tab.
- The kernel runs every cleanup from the old `setup(ctx)` (removing the badge and its `<style>`), then runs `setup(ctx)` again. `ctx.get('mediaIdBadgeFormat')` now returns the saved value, already validated against the allowed list, and the badge mounts with the new format.

Every option type, validators, and `childOf` nesting are in [Child Options](./define-module.md#child-options). When a module must set `requiresReload: true` instead, see [Hot-Reload vs. Page Reload](./define-module.md#hot-reload-vs-page-reload).

---

## Step 5: Add Structured Debug Logging

Raw `console.*` calls are forbidden in modules. Every module gets `ctx.log` instead:

- `ctx.log.warn(...)` and `ctx.log.error(...)` always work and are prefixed with `[<label>]` (which falls back to `title`, then `id`).
- `ctx.log.debug(...)` is blocked at compile time until you declare a `debug` block. This prevents shipping debug output that has no Developer Mode toggle.

Add this to `defineModule(...)`:

```ts
  debug: {
    label: 'Media ID Badge',
    title: 'Media ID Badge Debug',
    help: 'Log route detection and badge mounting.'
  },
```

TypeScript now accepts `ctx.log.debug(...)`:

```ts
ctx.log.debug('Mounting badge for', kind, id, 'format:', format);
```

Turn on Advanced, then Developer Mode, then Media ID Badge Debug in Settings (or set `window.__ALA_DEBUG__ = true` in DevTools) and the console prints `[Media ID Badge] Mounting badge for anime 16498 format: full`. With Developer Mode off, `ctx.log.debug` is silent and the saved debug preference is untouched.

Sub-channels and warn/error-only prefixes are configured in [Debug Logging](./define-module.md#debug-logging). The logger API itself is in [Logging](./context-api.md#logging).

---

## Complete Module

Putting every step together:

```ts
import { defineModule } from '../../core/registry';

const SIDEBAR_DATA = '.sidebar > .data';

export function formatBadgeText(kind: string, id: number | string, format: string): string {
  return format === 'short' ? `#${id}` : `${kind.toUpperCase()} #${id}`;
}

defineModule({
  id: 'mediaIdBadge',
  key: 'mediaIdBadgeEnabled',
  section: 'AniList Enhancements',
  title: 'Media ID Badge',
  help: 'Show the numeric AniList media ID in the sidebar on anime and manga pages.',
  requiresReload: false,
  options: [
    {
      key: 'mediaIdBadgeFormat',
      type: 'select',
      def: 'full',
      options: [
        ['full', 'Full (ANIME #16498)'],
        ['short', 'Compact (#16498)']
      ],
      title: 'Display Format',
      help: 'Choose how the media ID is formatted.'
    }
  ],
  debug: {
    label: 'Media ID Badge',
    title: 'Media ID Badge Debug',
    help: 'Log route detection and badge mounting.'
  },
  setup(ctx) {
    ctx.onRoute(/^\/(anime|manga)\/(\d+)(?:\/|$)/, (rc) => {
      const kind = rc.match![1];
      const id = rc.match![2];
      const format = ctx.get<string>('mediaIdBadgeFormat');
      ctx.log.debug('Mounting badge for', kind, id, 'format:', format);

      rc.mount({
        id: 'badge',
        anchor: SIDEBAR_DATA,
        position: 'beforebegin',
        ownUi: true,
        style: (sel) => `${sel} {
          margin-bottom: 12px;
          padding: 10px 14px;
          border-radius: 3px;
          background: rgb(var(--color-foreground));
          color: rgb(var(--color-text));
          font-size: 1.3rem;
          font-weight: 600;
        }`,
        create: () => {
          const el = document.createElement('div');
          el.textContent = formatBadgeText(kind, id, format);
          return el;
        }
      });
    });
  }
});
```

---

## Step 6: Manifest Permissions, Tests, and Verification

### When to edit vite.config.ts

The badge only touches AniList's DOM, so the manifest stays as it is. Edit `vite.config.ts` when a module needs something new:

- **External API calls (`ctx.http.*`):** add the bare hostname to `userscript.connect`, otherwise the userscript manager blocks or prompts on the request. See [Calling External APIs](./recipes.md#calling-external-apis).
- **Pages other than AniList (`hosts`):** add a matching pattern to `userscript.match`. See [Host Filtering](./define-module.md#host-filtering).
- **A new `GM_*` permission:** add it to `userscript.grant` and add a matching mock in `__tests__/setup.ts`. Modules still cannot call `GM_*` directly; this only applies to core code.

### Write a focused test

Create `__tests__/mediaIdBadge.test.ts`. It covers the pure helper and the real mount and teardown lifecycle through `bootModuleForTest`:

```ts
import { describe, it, expect } from 'vitest';
import { formatBadgeText } from '../src/modules/mediaIdBadge';
import { Settings } from '../src/settings/settings';
import { bootModuleForTest, createModuleHost } from '../src/core/registry';

describe('mediaIdBadge', () => {
  it('formats full and compact ID labels', () => {
    expect(formatBadgeText('anime', 16498, 'full')).toBe('ANIME #16498');
    expect(formatBadgeText('manga', 2, 'short')).toBe('#2');
  });

  it('mounts on media pages and tears down when disabled', async () => {
    document.body.innerHTML = '<div class="sidebar"><div class="data"></div></div>';
    history.replaceState({}, '', '/anime/16498');
    Settings.set('mediaIdBadgeEnabled', true);
    Settings.set('mediaIdBadgeFormat', 'short');

    await bootModuleForTest('mediaIdBadge');
    expect(document.getElementById('ala-mediaIdBadge-badge')?.textContent).toBe('#16498');

    Settings.set('mediaIdBadgeEnabled', false);
    createModuleHost().reload(['mediaIdBadge']);
    expect(document.getElementById('ala-mediaIdBadge-badge')).toBeNull();
  });
});
```

Tests, unlike modules, may import `Settings` directly. Importing the module file is what registers it, so the `formatBadgeText` import also makes `bootModuleForTest('mediaIdBadge')` work. More patterns are in [Lifecycle Tests](./testing.md#lifecycle-tests).

### Run the verification pipeline

```bash
npx tsc --noEmit && npm test && npm run build
```

This type-checks the project (including the `ctx.log` and `ctx.accounts` compile-time guards), runs your tests together with the layering and convention guards, and builds the userscript bundle. See [Testing & Verification](./testing.md) for the full workflow.
