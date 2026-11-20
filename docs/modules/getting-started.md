# Getting Started: Creating Your Own Module

This walkthrough takes you from an empty directory to a complete, reactive AL Additions module integrated into Settings, AniList SPA navigation, CSS injection, and tests.

---

## 1. Choose a Folder Layout

Every module lives in its own folder under `src/modules/<folderName>/` and must export/execute its registration inside `src/modules/<folderName>/index.ts`.

- **Small module:** Put everything in `src/modules/myFeature/index.ts`.
- **Complex module:** Split pure logic, UI modals, or sub-systems into sibling files in the same folder (`state.ts`, `helpers.ts`, `modal.ts`) and wire them from `index.ts`.

> **Important Rule on Side Effects:**
> Importing `index.ts` or any helper file inside your module must have **zero runtime side effects** (no `GM_getValue`, no `document.createElement`, no `window.addEventListener`, no top-level `addStyle`). Code only runs when the kernel invokes your `migrate()` or `setup(ctx)` functions. Pure helper exports at module top level are always safe so Vitest tests can import and test them directly.

---

## 2. Register Metadata with `defineModule`

Create `src/modules/mediaIdBadge/index.ts`. The example below demonstrates registering a toggleable feature with an option (`select`), CSS injection, a Developer Mode debug channel, AniList SPA route matching, and auto-repairing DOM mounting:

```ts
import { defineModule } from '../../core/registry';
import { findMediaSidebarSpot, mediaRoute } from '../../utils/anilistDom';

const BADGE_ID = 'ala-media-id-badge';
const STYLE_ID = 'ala-media-id-badge-style';

export function formatBadgeText(kind: 'anime' | 'manga', id: number, format: string): string {
  return format === 'short' ? `#${id}` : `${kind.toUpperCase()} #${id}`;
}

defineModule({
  id: 'mediaIdBadge',
  key: 'mediaIdBadgeEnabled',
  section: 'AniList Enhancements',
  layer: 'feature',
  requiresReload: false,
  title: 'Media ID Badge',
  help: 'Display the numeric AniList media ID in the sidebar on anime and manga pages.',
  debug: {
    label: 'Media ID Badge',
    title: 'Media ID Badge Debug',
    help: 'Log route detection and badge mounting in Developer Mode.'
  },
  options: [
    {
      key: 'mediaIdBadgeFormat',
      type: 'select',
      def: 'full',
      options: [
        ['full', 'Full (ANIME #1234)'],
        ['short', 'Compact (#1234)']
      ],
      title: 'Display Format',
      help: 'Choose how the media ID is formatted.'
    }
  ],
  setup(ctx) {
    // 1. Tell the observer to ignore mutations inside our own badge (prevents infinite loops)
    ctx.ownUi(`#${BADGE_ID}`);

    // 2. Inject scoped CSS; automatically removed if the user disables this module!
    ctx.addStyle(
      STYLE_ID,
      `#${BADGE_ID} {
        margin-bottom: 12px;
        padding: 10px 14px;
        border-radius: 3px;
        background: rgb(var(--color-foreground));
        color: rgb(var(--color-text));
        font-size: 1.3rem;
        font-weight: 600;
      }`
    );

    // 3. React whenever the user navigates to/between media pages
    ctx.onRoute(/^\/(anime|manga)\/(\d+)(?:\/|$)/, (rc) => {
      const route = mediaRoute(rc.url.pathname);
      if (!route) return;

      const format = ctx.get<string>('mediaIdBadgeFormat');
      ctx.log.debug('Mounting badge for', route.type, route.id, 'format:', format);

      // 4. Use rc.mount() so Vue re-renders automatically re-attach the element
      //    and navigating away or disabling the module automatically removes it.
      rc.mount({
        id: BADGE_ID,
        anchor: () => findMediaSidebarSpot()?.before ?? null,
        position: 'beforebegin',
        create: () => {
          const el = document.createElement('div');
          el.id = BADGE_ID;
          el.textContent = formatBadgeText(route.kind, route.id, format);
          return el;
        }
      });
    });
  }
});
```

### Why Each Piece Matters
- **`requiresReload: false`:** Because `ctx.addStyle`, `ctx.ownUi`, and `ctx.onRoute` -> `rc.mount` all register automatic cleanups, toggling this module **ON/OFF** or changing **Display Format** and pressing **Save** applies immediately in place via `ModuleHost.reload()` without reloading the browser tab.
- **`ctx.onRoute` + `rc.mount`:** AniList is a Vue Single-Page Application. Navigating from `/anime/1` to `/anime/20` changes the URL via `history.pushState` and asynchronously re-renders Vue components. `ctx.onRoute` re-runs on every navigation (first tearing down the old `rc` cleanups), and `rc.mount` waits for the sidebar anchor to appear in the DOM and repairs the badge if Vue re-renders the sidebar container.
- **Exported pure function (`formatBadgeText`):** Keeps business logic testable without DOM or GM mocks.

---

## 3. External Domains & Tampermonkey Manifest (`vite.config.ts`)

If your module calls an external API using `ctx.http.*`, embeds a new external domain in `@match`, or needs a new GM permission (`@grant`):

1. Add the hostname to `userscript.connect` in `vite.config.ts` (otherwise Tampermonkey blocks or prompts users on `GM_xmlhttpRequest`).
2. Add any new `@match` pattern if your module has `hosts` beyond AniList / MyAnimeList.
3. If you add a new `@grant`, mirror a mock implementation in `__tests__/setup.ts` so Vitest tests continue working.

---

## 4. Check Architecture & Tests

Run the standard verification pipeline:

```bash
npx tsc --noEmit
npm test
npm run build
```

Notice what `__tests__/layering.test.ts` and `__tests__/conventions.test.ts` automatically verify for your new folder:
1. All imports inside `src/modules/yourModule/` obey the layering DAG rules.
2. Dynamically importing `src/modules/yourModule/index.ts` executes zero `GM_*`, DOM, `<style>`, or global listener side effects at import time.
3. No raw session/auth keys, hardcoded prefixes, raw `GM_*` calls, `ctx.api.session` bypasses, or raw `console.*` calls exist inside `src/modules/yourModule/`.
4. Any `migrate(m)` hook includes a valid `// @migration(from: "...", kind: "...", sunset: "...")` annotation.

Add unit tests in `__tests__/myFeature.test.ts` importing your pure helpers or testing full lifecycle via `bootModuleForTest('<id>')` (see [Architecture & Testing](./architecture-and-communication.md#testing-your-module)).
