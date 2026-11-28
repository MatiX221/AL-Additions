# Recipes & Patterns

Complete patterns for jobs that come up repeatedly. Each recipe uses only the public APIs and links to the corresponding reference page for full details.

- [Staged JSON Modal Editors](#staged-json-modal-editors)
- [Calling External APIs](#calling-external-apis)
- [Writing Migrations](#writing-migrations)
- [Yielding to Standalone Scripts](#yielding-to-standalone-scripts)
- [Adding an Account Provider](#adding-an-account-provider)

---

## Staged JSON Modal Editors

Use this when an option holds structured data (a list of presets, a table of colors) and a raw text box would be unfriendly. The option has `type: 'json'`, and the Settings panel shows a **Customize** button that opens your editor.

The key idea is **staging**. The editor works on a copy and hands the result back with `onApply`. Nothing is saved until the user presses Save in the Settings panel, and Cancel simply discards the copy. See [Child Options](./define-module.md#child-options).

### 1. Write the validator

A validator turns untrusted data (from storage, a backup file, or the editor) into a clean value. Return `valid: false` for anything unusable, and the setting falls back to its default.

```ts
export interface Preset {
  id: string;
  name: string;
  url: string;
}

export const DEFAULT_PRESETS: Preset[] = [
  { id: 'example', name: 'Example', url: 'https://example.com/?q={title}' }
];

export function validatePresets(raw: unknown): { valid: boolean; value?: Preset[]; error?: string } {
  if (!Array.isArray(raw) || !raw.length) return { valid: false, error: 'Expected a non-empty array.' };
  const presets: Preset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = String(item?.id ?? '').trim();
    const name = String(item?.name ?? '').trim();
    const url = String(item?.url ?? '').trim();
    if (!id || !name || !/^https?:\/\//i.test(url) || seen.has(id)) {
      return { valid: false, error: `Invalid preset "${id}".` };
    }
    seen.add(id);
    presets.push({ id, name, url });
  }
  return { valid: true, value: presets };
}
```

When a validator returns an object, the cleaned value is taken from the first of `value`, `tiers`, `config`, or `overrides` that is present. Use `value` unless you have a reason not to. If the validator returns `{ valid: true }` with none of those, the input is kept as is (deep-cloned with own `__proto__` keys stripped). A validator that throws is treated as invalid.

### 2. Write the editor

The editor receives a `JsonEditorContext`. It has no `ctx`, so everything comes from that object:

| Member | Use it for |
| :--- | :--- |
| `value` | The staged value to start from. Clone it. |
| `onApply(next)` | Hand the edited value back to the Settings panel. |
| `signal` | Read-only `AbortSignal` that aborts when the editor session closes (when its last modal closes or when the Settings panel closes). |
| `getId(name?)` | Allocate a namespaced element id. |
| `addStyle(css)` / `addStyle(id, css)` | Inject CSS (`CssSource`: string or lazy function), disposed when the editor's modal or Settings panel closes. Returns a cleanup. |
| `listen(target, type, fn, options?)` | Add a listener on `document` or `window`, removed when the editor's modal or Settings panel closes. Returns a cleanup. |
| `timeout(fn, ms)` | Tracked `setTimeout` cleared when the editor's modal or Settings panel closes. Returns a cleanup. |
| `observe(target, options, cb)` | Lifecycle-scoped `MutationObserver` on `target`, disconnected automatically when the editor session or Settings panel closes. Returns a cleanup. |
| `modal(opts)` | Open a managed modal dialog (`{ id, selector, signal, backdrop, sheet, body, footer, close, listen, timeout, onCleanup }`) supporting `subtitle`, `style`, and `[data-ala-close]` click delegation; auto-closed on panel close and triggering session cleanup when the last session modal closes. |
| `confirm(opts)` | Open a stacked, non-blocking confirmation dialog (`string \| ConfirmOptions`, with optional `signal?: AbortSignal`) returning `Promise<boolean>` (resolves `false` on Cancel, `Escape`, backdrop click, `signal` abort, or session close). |
| `alert(opts)` | Open a stacked, non-blocking alert dialog (`string \| AlertOptions`, with optional `signal?: AbortSignal`) returning `Promise<void>` (resolves on OK, `Escape`, backdrop click, `signal` abort, or session close). |
| `toast` | Show a non-blocking toast (`{ show, success, error }`, `ToastApi`), ignored once the editor session closes or the Settings panel detaches. |
| `onCleanup(fn)` | Register custom cleanup logic run when the editor session closes (immediately if already closed). |
| `api` | Optional lifecycle-scoped AniList client (`Omit<AniListClient, 'session'>`) bound to `ec.signal` (aborts in-flight queries/reads and rejects post-close mutations when the editor session or Settings panel closes). May be missing. |
| `log` | An optional logger with `warn` and `error`. |

```ts
import type { JsonEditorContext } from '../../types';
import { esc } from '../../utils/helpers';

const buildEditorCss = (sel: string): string => `
  ${sel} .ala-ex-list { margin: 0; padding-left: 18px; }
  ${sel} .ala-ex-list li { margin: 4px 0; }
`;

export function openExampleEditor(ec: JsonEditorContext): void {
  const draft: Preset[] = structuredClone(ec.value);

  const modal = ec.modal({
    id: 'example-editor',
    title: 'Presets',
    maxWidth: '560px',
    style: buildEditorCss,
    bodyHtml: `<ul class="ala-ex-list">${draft.map((p) => `<li>${esc(p.name)}</li>`).join('')}</ul>`,
    footerHtml: `
      <button type="button" class="ala-btn ala-btn--primary" data-act="apply">Apply</button>
      <button type="button" class="ala-btn" data-ala-close>Cancel</button>
    `
  });

  modal.footer.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'apply') {
      ec.onApply(draft);
      modal.close();
    }
  });
}
```

Rules that keep the editor safe:

- Never call `Settings.get` or `Settings.set`, and never write to storage. `onApply` is the only way out.
- Open the dialog with `ec.modal(...)` so backdrop dismissal, top-of-stack `Escape` handling (without closing the Settings panel underneath), `[data-ala-close]` button delegation, and session cleanup (on last session modal close, or Settings panel close as fallback) are handled automatically; `ec.signal` aborts and `ec.addStyle`, `ec.listen`, `ec.timeout`, `ec.observe`, and `ec.onCleanup` registrations are disposed when the session closes (replacing a duplicate `modal({ id })` closes only the old modal while keeping the session alive).
- Escape every dynamic string with `esc(...)` before putting it into `innerHTML`.
- Pass short unprefixed IDs (`'example-editor'`, `'editor-style'`) to `ec.modal` and `ec.addStyle`, and scope custom CSS against `style: (sel) => ...` or `modal.selector`, see [Styles](./context-api.md#styles) and [Modals](./context-api.md#modals).

### 3. Wire it into the option

```ts
options: [
  {
    key: 'examplePresets',
    type: 'json',
    def: DEFAULT_PRESETS,
    title: 'Presets',
    help: 'Customize the available presets.',
    validate: validatePresets,
    editor: openExampleEditor
  }
]
```

Read the saved value with `ctx.get('examplePresets')`. It is always valid, so no extra checks are needed.

---

## Calling External APIs

Three things must line up: the manifest, the request, and the lifecycle.

### 1. Allow the host in the manifest

Add the bare hostname to `userscript.connect` in `vite.config.ts`:

```ts
connect: [
  'graphql.anilist.co',
  'api.example.com'
],
```

- Write bare hostnames only: no `https://`, no path, and no Markdown link syntax.
- Subdomains are separate entries. `www.example.com` does not cover `api.example.com`.
- If the module also runs on that site, add it to `userscript.match` and to the module's `hosts`, see [Host Filtering](./define-module.md#host-filtering).

### 2. Make the request

```ts
interface SearchResult { id: number; title: string }

async function search(http: FeatureContext['http'], query: string): Promise<SearchResult[]> {
  const res = await http.request(
    `https://api.example.com/search?q=${encodeURIComponent(query)}`,
    { headers: { Accept: 'application/json' }, timeout: 10000 }
  );
  if (res.status === 404) return [];
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.responseText).results as SearchResult[];
}
```

Use `http.json` (`ctx.http.json` or `rc.http.json`) when any non-2xx status can simply be an error. Use `request` when you need to treat specific statuses differently, as above. The full API is in [Networking](./context-api.md#networking).

### 3. Respect the route lifecycle

```ts
ctx.onRoute(/^\/(anime|manga)\/(\d+)/, async (rc) => {
  let results: SearchResult[];
  try {
    results = await search(rc.http, `media ${rc.match![2]}`);
  } catch (e: any) {
    if (rc.signal.aborted || e?.message === 'Request aborted') return;
    ctx.log.warn('Search failed:', e);
    return;
  }
  if (rc.signal.aborted) return;

  rc.mount({ id: 'results', anchor: '.overview', position: 'beforeend', create: () => buildResults(results) });
});
```

- Using `rc.http` binds the request to `rc.signal`, so navigating away or unloading the module aborts it and rejects with `Request aborted`. Treat that as normal control flow and return quietly.
- Check `rc.signal.aborted` after every `await`. The user may have navigated away.

### 4. Be a good citizen

- **Cache results.** Use `ctx.persistent` with an expiry per entry, see [Persistent Caches](./context-api.md#persistent-caches). `memo` from `utils/helpers` caches async lookups by key, and `createSharedFlight` from `utils/flight` coordinates waiter-isolated concurrent flights.
- **Limit the rate.** Create a `RateLimiter` for each external service and `await limiter.acquire({ signal: rc.signal })` before each request, see [utils/limiter.ts](./platform-apis.md#utilslimiterts). Call `limiter.limit(ms)` when the server answers 429, using its `Retry-After` header when present.
- **Fail soft.** A broken third-party site should never break the page. Catch, log with `ctx.log.warn`, and render nothing.

---

## Writing Migrations

Migrations carry users' saved data across script versions. They run on every page load, for every module including disabled ones, before any module starts. See [Migrations](./define-module.md#migrations) for the rules. The patterns below all follow the same shape: check whether the old data exists, move it, delete it.

Every `migrate` hook or migration helper must carry an adjacent leading or in-body valid annotation:

```ts
// @migration(from: "v0.9.1", kind: "storage", sunset: "2-3 releases")
```

### Move a renamed storage key

```ts
migrate(m) {
  // @migration(from: "v0.9.1", kind: "storage", sunset: "2-3 releases")
  const old = m.legacy.get<string | null>('old_raw_key', null);
  if (old === null) return;
  if (m.storage.get('new_key', null) === null) m.storage.set('new_key', old);
  m.legacy.del('old_raw_key');
}
```

Never overwrite a value that already exists in the new location. A user who upgraded and later reinstalled an old version would otherwise lose newer data.

### Version a bigger upgrade

When a migration has several steps, record progress in a schema number so each step runs once:

```ts
migrate(m) {
  // @migration(from: "pre-0.8.0", kind: "storage", sunset: "keep-long")
  const schema = m.storage.get<number>('schema', 0);
  if (schema < 2) {
    m.legacy.del('stale_mirror_cache');
    m.storage.set('schema', 2);
  }
  if (schema < 3) {
    for (const t of ['ANIME', 'MANGA']) {
      const raw = m.legacy.get<unknown>(`old_idmap_${t}`, undefined);
      if (raw !== undefined) {
        m.storage.set(`idmap_${t}`, raw);
        m.legacy.del(`old_idmap_${t}`);
      }
    }
    m.storage.set('schema', 3);
  }
}
```

Guard each step by the old data and the schema number together. Writing the new schema number last means a half-finished migration retries on the next load.

### Remove an obsolete cache

```ts
migrate(m) {
  // @migration(from: "v0.9.1", kind: "cleanup", sunset: "2-3 releases")
  m.legacy.del('example-cache-v1');
}
```

This is also how to clean up a `ctx.persistent` cache written before keys were scoped to the module. Delete the old raw key here, and let the new scoped key start empty.

### Clean up localStorage

Modules cannot touch `localStorage` directly. Migrations can, through `m.legacy`:

```ts
migrate(m) {
  // @migration(from: "v0.9.1", kind: "cleanup", sunset: "2-3 releases")
  if (m.storage.get<boolean>('localStorageCleaned', false)) return;
  for (const key of ['example:cache:v1', 'example:state']) m.legacy.delLocal(key);
  m.storage.set('localStorageCleaned', true);
}
```

The flag avoids touching `localStorage` on every load. `getLocal(key)` returns the string value or `null`, and both calls swallow storage errors.

### Import a setting from an older format

```ts
migrate(m) {
  // @migration(from: "v0.8.0", kind: "import", sunset: "keep-long")
  const raw = m.legacy.getLocal('oldSettingsBlob');
  if (!raw || m.settings.has('exampleConfig')) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.items)) m.settings.set('exampleConfig', parsed.items);
  } catch {}
}
```

`m.settings.set` normalizes through the option's validator, so a malformed import is discarded rather than saved. Test every migration twice in a row to prove it is idempotent, see [Testing Migrations](./testing.md#testing-migrations).

---

## Yielding to Standalone Scripts

A feature that began as its own userscript may still be installed next to the built-in version. Two copies would duplicate the UI or fight over the same hooks. The built-in module steps aside, and the user's saved setting is kept for when the standalone script is removed.

### 1. Describe how to detect it

Declare `standalone` with a probe. A probe returns `true` or a promise of `true` when the other script is present. Common signals are a page global the script sets, an attribute it adds, or its visible effect on the DOM.

```ts
let probeCache: { at: number; result: Promise<boolean> } | null = null;

function probeOtherScript(timeoutMs = 600): Promise<boolean> {
  if (probeCache && Date.now() - probeCache.at < 30_000) return probeCache.result;
  const result = (async () => {
    if (!document.body) return false;
    const bait = document.createElement('div');
    bait.className = 'score';
    bait.hidden = true;
    bait.setAttribute('score', '9');
    bait.setAttribute('data-ala-probe', '1');
    document.body.appendChild(bait);
    try {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        await sleep(50);
        if (bait.hasAttribute('data-other-script-touched')) return true;
      }
      return false;
    } finally {
      bait.remove();
    }
  })();
  probeCache = { at: Date.now(), result };
  return result;
}

defineModule({
  id: 'example',
  key: 'exampleEnabled',
  title: 'Example',
  help: '...',
  standalone: { name: 'Example Standalone Script', probe: () => probeOtherScript() },
  setup(ctx) { /* ... */ }
});
```

The kernel probes when the Settings panel opens, which updates the toggle and shows the note. Caching the answer for a short time prevents repeated work.

If the probe plants bait elements like the one above, the built-in logic must skip them, so give the bait an attribute (here `data-ala-probe`) and have the built-in code ignore elements that carry it.

### 2. Do not wait for the probe on every page load

A probe that polls the DOM would delay the feature. Remember the last result and act on it immediately, then confirm in the background:

```ts
setup(ctx) {
  let paused = !!ctx.storage.get<boolean>('standalone_seen', false);

  const run = () => { if (!paused) applyFeature(); };

  ctx.ready(() => {
    run();
    const unsubNav = ctx.onNav(run);

    void probeOtherScript().then((found) => {
      ctx.storage.set('standalone_seen', found);
      const wasPaused = paused;
      paused = found;
      ctx.setStandalonePaused(found);
      if (found) {
        unsubNav();
        if (!wasPaused) ctx.log.warn('Built-in feature paused: the standalone script is installed.');
      } else if (wasPaused) {
        run();
      }
    });
  });
}
```

`ctx.setStandalonePaused(true)` disposes the module and any module that depends on it, and the status becomes `standalone-paused`. Passing `false` clears the flag, but the module only restarts on the next reload, which is why the code above also runs the feature directly in that case.

### 3. Detect the built-in copy from the other side

Intercept-layer features often set a page global (for example a version string) so that other code can recognize them. If the standalone script uses the same global, check that it was not set by you:

```ts
let builtInRunning = false;
const detectStandalone = (): boolean => !!pageGlobal.__OTHER_FLAG__ && !builtInRunning;

// in setup, after confirming there is no conflict
builtInRunning = true;
```

Use the same `detectStandalone` function as the probe and inside `setup`, so the verdicts agree. A module that finds a conflict in `setup` returns early after calling `ctx.setStandalonePaused(true)`.

---

## Adding an Account Provider

An account provider describes a third-party service the user can connect (for example through OAuth). The kernel then shows it under Connected Accounts in Settings, protects its secrets in backups, and lets modules use it through `ctx.accounts`.

### 1. Register the provider

Create `src/api/<service>.ts`. Files in `api/` may import `core/accounts`, `core/toast`, and `utils/*`, but not `core/registry`.

```ts
import { registerAccountProvider } from '../core/accounts';
import { showToast } from '../core/toast';
import { store, openTab, randomString } from '../utils/helpers';

const SECRET_KEYS = ['example_token', 'example_expires_at'] as const;

export const isExampleConnected = (): boolean => !!store.get('example_token', null);

export function connectExample(): void {
  const verifier = randomString(96);
  store.set('example_code_verifier', verifier);
  openTab(`https://example.com/oauth/authorize?code_challenge=${encodeURIComponent(verifier)}`);
}

export function disconnectExample(): void {
  for (const key of SECRET_KEYS) store.del(key);
}

registerAccountProvider({
  id: 'example',
  name: 'Example Service',
  secretKeys: [...SECRET_KEYS, 'example_code_verifier'],
  isConnected: () => isExampleConnected(),
  connect: () => connectExample(),
  disconnect: () => disconnectExample(),
  onAuthCallback: () => captureCredentials()
});
```

| Field | Meaning |
| :--- | :--- |
| `id` | The id modules list in `accounts`. |
| `name` | Label in Settings. |
| `secretKeys` | Every storage key that holds credentials. Used for backups and for `clearSecrets`. List all of them, including temporary ones. |
| `isConnected()` | Must be cheap and synchronous. |
| `connect()`, `disconnect()` | Start and undo the connection. |
| `onAuthCallback()` | Optional. Called once at startup, for providers that finish a login on a redirect page. |

Registration happens when the file is imported, so import it once from `src/main.ts` (a bare `import './api/example';`). Order matters only in that it must happen before `startModules` runs, which the existing imports already satisfy.

### 2. Finish the login on the redirect page

OAuth usually returns to a URL on the service's own site, so the script must run there. Add the host to `userscript.match` and `userscript.connect` in `vite.config.ts`, then read the code in `onAuthCallback`:

```ts
export function captureCredentials(): void {
  if (location.hostname !== 'example.com') return;
  const code = new URLSearchParams(location.search).get('code');
  if (!code || !store.get('example_code_verifier')) return;
  exchangeCode(code)
    .then(() => showToast('Connected! You can close this tab.', { type: 'success', closeTab: true }))
    .catch((e) => showToast('Connection failed: ' + e.message, { type: 'error' }));
}
```

Callbacks run one after another, and a callback that throws is logged without stopping the rest.

### 3. How secrets are backed up

Settings backups never include provider secrets unless the user chooses "Export with Credentials", which requires a password and encrypts the file. On import, each stored secret is validated by key name before it is applied:

- Keys ending in `_at` must be finite, non-negative numbers (expiry timestamps).
- Every other secret key must be a non-empty string.

Invalid values are skipped silently, so name expiry keys with the `_at` suffix and keep other secrets as strings. AniList's own session keys are never exported or imported.

### 4. Use it from a module

```ts
defineModule({
  id: 'exampleSync',
  key: 'exampleSyncEnabled',
  accounts: ['example'],
  title: 'Example Sync',
  help: '...',
  setup(ctx) {
    ctx.accounts.watch('example', (connected) => renderStatus(connected));
    if (!ctx.accounts.isConnected('example')) return;
    // ...
  }
});
```

Declaring `accounts` is mandatory. The module cannot read the provider, or clear its secrets, otherwise. See [Accounts](./platform-apis.md#accounts).
