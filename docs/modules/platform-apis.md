# Platform & Shared APIs

Modules share domain APIs under `src/api/` and `src/utils/` instead of re-implementing GraphQL clients, rate limiters, or AniList DOM selectors.

---

## AniList Client (`ctx.api` and `ctx.session`)

Access the rate-limited AniList GraphQL client via `ctx.api` (backed by `anilistApiClient` in `src/api/anilist.ts`):

### Authentication & Viewer Info
> Always read/update AniList session state through **`ctx.session`** (never `ctx.api.session`, which is blocked in modules by `__tests__/conventions.test.ts`). Both `ctx.session` and `ctx.api.session` are lifecycle-wrapped per module so disposed contexts cannot mutate session state.

- **`ctx.session.peek(opts?: { reconcile?: boolean })`**: Pure read returning `{ userId, username, scoreFormat }` from Nuxt state, navbar, entity cache, and stored session keys with **zero side effects** (safe at `document-start` even when `document.body === null`). Pass `{ reconcile: true }` when you explicitly want `syncFromPage()` to run first.
- **`ctx.session.userId` / `ctx.session.username` / `ctx.session.scoreFormat`**: Live pure getters backed by `peek()`.
- **`ctx.session.recordHint({ userId?, username? })`**: Persists viewer hints discovered from AniList API/RPC `Viewer` responses. Guarded against logged-out pages, page-user mismatches, and `CoreHooks.isSessionClearing()`.
- **`ctx.session.hasAuth()` / `ctx.api.hasAuth()`**: Synchronously checks whether a captured AniList bearer token (`al_token_auth`) or logged-in Nuxt state exists without triggering any network request.
- **`ctx.session.syncFromPage?.()`**: Synchronously reconciles cached viewer identity against the current DOM/Nuxt auth state (clearing stale identity if the user logged out or switched AniList accounts).
- **`ctx.session.clear()` / `ctx.api.clearViewer()`**: Clears all AniList session keys (`al_token`, `al_username`, `al_user_id`, `al_score_format`, `al_token_auth`) and resets cached auth headers cleanly.
- **`ctx.api.viewer(forceFresh = false)`**: Returns `{ id: number; name: string; scoreFormat: string } | null`. Syncs logged-in user info from the page's Vue/Nuxt state (`__NUXT__`), falling back to cached values or a GraphQL `Viewer` query when authenticated. Returns `null` when logged out.
- **`ctx.api.resumeAt()`**: Returns epoch timestamp (ms) until which AniList requests are backed off due to rate-limiting (`0` if clear).

### GraphQL Queries & Media Actions
- **`ctx.api.query<T>(query, variables?, optionsOrRetries?)`**: Executes a rate-limited GraphQL query with retry/429 backoff. Throws `{ auth: true }` on 401/invalid auth.
- **`ctx.api.getMediaList(target, type = 'ANIME', options?)`**: Fetches full `MediaListCollection` for a user ID or username, deduplicating entries across custom lists, honoring active rate limits and shared fast-load caches when present, and returning `{ allEntries, lists, user }`.
- **`ctx.api.invalidate(prefix?)` / `ctx.api.invalidateMediaList(target?, type?)`**: Evicts cached GraphQL entries after mutations.
- **`ctx.api.media.get(id, type, opts?)`**: Fetches cached/shared media metadata (`id`, `idMal`, `title`, `episodes`, `chapters`, `nextAiringEpisode`, `mediaListEntry` with score, progress, status, etc.).
- **`ctx.api.media.save(id, type, patch)`**: Saves `{ score?, progress?, status?, completedAt? }` via `SaveMediaListEntry` mutation and invalidates affected list caches.

---

## Accounts API (`ctx.accounts`)

Allows modules to read status and trigger connect/disconnect flows for registered OAuth/account providers (e.g. `'mal'`) without hardcoding token storage keys:

```ts
if (!ctx.accounts.isConnected('mal')) {
  ctx.accounts.connect('mal'); // Opens authorization flow
}

ctx.accounts.disconnect('mal');      // Clears provider secret keys cleanly
ctx.accounts.clearSecrets('mal');    // Clears secret keys for 'mal' only
ctx.accounts.clearSecrets();         // Clears secret keys for ALL registered providers

// Subscribe to connection state transitions (fires ONLY when isConnected() flips true <-> false;
// supports providers registered before or after subscribing; auto-cleaned on module unload):
ctx.accounts.watch('mal', (connected) => {
  renderAccountStatus(connected);
});
```

If you implement a new external account integration in `src/api/<provider>.ts`:
1. Export and register an `AccountProvider` via `registerAccountProvider(...)` (`src/core/accounts.ts`) declaring `{ id, name, secretKeys, isConnected, connect, disconnect, onAuthCallback? }`.
2. Import your provider in `src/main.ts`.
3. Connected Accounts in Settings and Backup **Export with Secrets** automatically discover your provider and protect its `secretKeys` dynamically, so no changes to Settings or Backup are required.

---

## AniList DOM & Route Helpers (`src/utils/anilistDom.ts`)

Use the shared selectors and parsers instead of scattering brittle CSS selectors across modules:

### Route Parsers
Each parser accepts an optional `pathname` (defaulting to `location.pathname`) and safely URL-decodes segments:

| Function | Matches | Return Shape |
| :--- | :--- | :--- |
| `mediaRoute(pathname?)` | `/anime/:id`, `/manga/:id` | `{ kind: 'anime' \| 'manga', type: 'ANIME' \| 'MANGA', id: number } \| null` |
| `listRoute(pathname?)` | `/user/:name/animelist`, `/user/:name/mangalist` | `{ owner: string, type: 'ANIME' \| 'MANGA' } \| null` |
| `compareRoute(pathname?)` | `/user/:name/(animelist\|mangalist)/compare` | `{ userName: string, kind: 'anime' \| 'manga', type: 'ANIME' \| 'MANGA' } \| null` |
| `staffOrStudioRoute(pathname?)` | `/staff/:id`, `/studio/:id` | `{ kind: 'staff' \| 'studio', id: string } \| null` |
| `decodeRouteSegment(s)` | Any URL path segment | Safely decoded string (falls back to raw string on malformed URI) |

### Navigation, Auth & DOM Spot Finders
- `ANILIST_SELECTORS`: Canonical selector constants (`loginNav`, `userNav`, `loggedInNav`, `mediaTitle`, `sidebarData`, `overview`, `banner`, `filtersSlot`, `compareRoot`, `listWrap`, `listEntry`, `shuffleControl`).
- `isLoggedOutNav(doc?)` / `hasLoggedInNav(doc?)` / `navUserName(doc?)`: Fast synchronous nav bar checks.
- `findMediaTitleHeader(doc?)`: Returns `.page-content .header .content > h1`.
- `findMediaSidebarSpot(doc?)`: Returns `{ parent, before }` targeting `.sidebar > .data` on media pages so sidebar widgets sit cleanly above the data box.
- `findOverviewContainer(doc?)`: Returns `.overview` container on media pages.
- `findBannerElement(doc?)`: Returns `.banner` header image element.
- `findSyncPanelAnchor(doc?)`: Locates the sidebar anchor on user list pages (`[title*="Random List Entry"]` or Sort group parent).

---

## General Utility Modules

### `src/utils/helpers.ts`
- `esc(str)`: HTML-escapes `& < > "` for safe template interpolation inside `.innerHTML`.
- `clean(str)` / `parseToggle(val)` / `sleep(ms)` / `randomString(len)`.
- `safe(fn, label?)` / `tryOr(asyncFn, fallback?)`: Non-throwing error guards.
- `debounce(fn, ms)` / `memo(asyncFn, keyFn?, ttlMs?)`: Deduplicates concurrent async calls and caches results.
- `openTab(url)`: Safe cross-environment tab opener (`GM_openInTab` fallback to `window.open(..., 'noopener,noreferrer')`).
- `downloadFile(url, name, opts?)`: Safe `GM_download` wrapper handling `onload`, `onerror`, `ontimeout`, `onabort`, and optional tab fallback (modules should call `ctx.http.download(...)` instead).
- `store`: Safe typed `GM_*` wrapper (`get`, `set`, `del`, `list`, `watch`) with guards when `GM_*` globals are unavailable.
- `createCoreLogger('core' | 'settings' | 'anilist' | 'mal')`: Frozen logger for non-module layers (`src/core/*`, `src/settings/*`, `src/api/*`), gated under **Core / Kernel Debug** (`debug.core`) in Developer Mode. *(Feature modules must use `ctx.log` instead.)*

Additionally, `Settings.has(key)` (`src/settings/settings.ts`) checks whether a registered setting has an explicit stored value in GM storage without falling back to its default.

### `src/utils/dom.ts`
- `icon(name, size = 18)`: Clean inline SVG icons (`'external'`, `'edit'`, `'chevron'`, `'close'`, `'sliders'`, `'resync'`, `'list'`, `'stop'`, `'spinner'`, etc.).
- `findExactText(text)`: Locates the deepest visible element matching exact trimmed text (useful when locating Vue links with no stable class names).

### `src/utils/limiter.ts`
- `RateLimiter` / `CircuitBreaker` / `runWithLimit(concurrency, items, fn)`: Token/interval limiters and backoff breakers for external APIs.

---

## Custom JSON Sub-Modal Editors (`SettingOption.editor`)

Complex configuration objects (`type: 'json'`) should provide a rich modal UI rather than forcing users to edit raw JSON in Settings.

To integrate cleanly with Settings' staged **Save / Reset / Cancel** flow:

1. Define your modal opener accepting `JsonEditorContext` (`{ value, onApply, addStyle, log? }`):

```ts
import type { JsonEditorContext } from '../../types';

const MODAL_CSS = `
  #ala-my-editor { position: fixed; inset: 0; z-index: 100001; ... }
`;

export function openMyEditor(ec: JsonEditorContext): void {
  // 1. Inject styles via the provided addStyle helper (never import core/styles directly in modules!)
  ec.addStyle('ala-my-editor-style', MODAL_CSS);

  // 2. Clone the staged value passed by Settings (do NOT call Settings.get / Settings.set inside the modal!)
  let draft = structuredClone(ec.value);

  const backdrop = document.createElement('div');
  backdrop.id = 'ala-my-editor';
  // ... build dialog UI, edit `draft` locally ...

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);

  // Optional diagnostics inside modals use `ec.log?.warn(...)` / `ec.log?.error(...)` (never raw console.*)

  // Confirm button stages the new value back into Settings without writing storage directly:
  applyBtn.addEventListener('click', () => {
    ec.onApply(draft);
    close();
  });

  // Cancel / backdrop / close button discards `draft` cleanly:
  cancelBtn.addEventListener('click', close);
  document.body.appendChild(backdrop);
}
```

2. Attach `editor: openMyEditor` and `validate` to your `SettingOption` inside `defineModule`:

```ts
options: [
  {
    key: 'myJsonConfig',
    type: 'json',
    def: DEFAULT_CONFIG,
    title: 'Configure Providers',
    help: 'Customize entries and ordering.',
    validate: validateMyConfig,
    editor: openMyEditor
  }
]
```

> **Note:** Keep your modal inside `src/modules/<yourModule>/` and pass `ec.addStyle` down rather than importing `src/core/styles.ts`. This keeps your module compliant with the layering DAG rules.
