import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const SRC_ROOT = path.resolve(process.cwd(), 'src');

const KNOWN_VIOLATIONS: string[] = [];

type Layer = 'types' | 'main' | 'utils' | 'core' | 'settings' | 'api' | 'module';

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

function toRelPosix(absPath: string): string {
  return path.relative(SRC_ROOT, absPath).replace(/\\/g, '/');
}

interface ImportToken {
  type: 'ident' | 'string' | 'number' | 'regex' | 'template' | 'punct';
  value: string;
  line: number;
}

const REGEX_PREV_IDENT_KEYWORDS = new Set([
  'return',
  'case',
  'throw',
  'in',
  'of',
  'instanceof',
  'typeof',
  'void',
  'delete',
  'new',
  'yield',
  'await',
  'else',
  'do',
  'export',
  'default',
  'extends'
]);

const REGEX_PREV_PUNCT = new Set([
  '(',
  '[',
  '{',
  ';',
  ',',
  ':',
  '?',
  '=',
  '!',
  '&',
  '|',
  '^',
  '~',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '=>',
  '...'
]);

function isRegexAllowedAfter(prev: ImportToken | null): boolean {
  if (!prev) return true;
  if (prev.type === 'ident') return REGEX_PREV_IDENT_KEYWORDS.has(prev.value);
  if (prev.type === 'punct') return REGEX_PREV_PUNCT.has(prev.value);
  return false;
}

function findRegexEnd(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  const len = source.length;
  while (i < len) {
    const c = source[i];
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < len && /[a-z]/i.test(source[i])) i++;
      return i;
    }
    i++;
  }
  return -1;
}

function tokenizeForImports(source: string): ImportToken[] {
  const tokens: ImportToken[] = [];
  const len = source.length;
  let i = 0;
  let line = 1;
  // Tracks brace nesting inside `${ ... }` template interpolations so closing `}` resumes the template text.
  const templateBraceStack: number[] = [];
  let braceDepth = 0;

  const pushToken = (type: ImportToken['type'], value: string, tokLine: number) => {
    tokens.push({ type, value, line: tokLine });
  };

  const scanTemplateBody = (startLine: number): void => {
    while (i < len) {
      const c = source[i];
      if (c === '\n') {
        line++;
        i++;
        continue;
      }
      if (c === '\\') {
        if (i + 1 < len && source[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        pushToken('template', '`', startLine);
        return;
      }
      if (c === '$' && source[i + 1] === '{') {
        i += 2;
        braceDepth++;
        templateBraceStack.push(braceDepth);
        return;
      }
      i++;
    }
    pushToken('template', '`', startLine);
  };

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const startLine = line;
      i++;
      let val = '';
      while (i < len) {
        const c = source[i];
        if (c === '\n') line++;
        if (c === '\\') {
          if (i + 1 < len && source[i + 1] === '\n') line++;
          val += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        val += c;
        i++;
      }
      pushToken('string', val, startLine);
      continue;
    }
    if (ch === '`') {
      const startLine = line;
      i++;
      scanTemplateBody(startLine);
      continue;
    }
    if (ch === '/' && isRegexAllowedAfter(tokens[tokens.length - 1] ?? null)) {
      const end = findRegexEnd(source, i);
      if (end !== -1) {
        pushToken('regex', source.slice(i, end), line);
        i = end;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[A-Za-z0-9_$]/.test(source[i])) i++;
      pushToken('ident', source.slice(start, i), line);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[0-9A-Za-z_.]/.test(source[i])) i++;
      pushToken('number', source.slice(start, i), line);
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      pushToken('punct', '{', line);
      i++;
      continue;
    }
    if (ch === '}') {
      if (templateBraceStack.length > 0 && templateBraceStack[templateBraceStack.length - 1] === braceDepth) {
        templateBraceStack.pop();
        braceDepth--;
        i++;
        scanTemplateBody(line);
        continue;
      }
      braceDepth = Math.max(0, braceDepth - 1);
      pushToken('punct', '}', line);
      i++;
      continue;
    }
    if (ch === '.' && next === '.' && source[i + 2] === '.') {
      pushToken('punct', '...', line);
      i += 3;
      continue;
    }
    if (ch === '=' && next === '>') {
      pushToken('punct', '=>', line);
      i += 2;
      continue;
    }
    if (ch === '?' && next === '.') {
      pushToken('punct', '?.', line);
      i += 2;
      continue;
    }
    if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
      pushToken('punct', ch + next, line);
      i += 2;
      continue;
    }
    pushToken('punct', ch, line);
    i++;
  }

  return tokens;
}

function skipBalancedBraces(tokens: ImportToken[], openIdx: number): number {
  let depth = 0;
  let j = openIdx;
  while (j < tokens.length) {
    if (tokens[j].value === '{') depth++;
    else if (tokens[j].value === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return j;
}

export function extractRelativeSpecifiers(source: string): string[] {
  const tokens = tokenizeForImports(source);
  const specifiers: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== 'ident') continue;
    const prev = i > 0 ? tokens[i - 1] : null;
    if (prev && (prev.value === '.' || prev.value === '?.')) continue;

    if (tok.value === 'import') {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.value === '(') {
        const arg = tokens[i + 2];
        if (arg?.type === 'string') {
          specifiers.push(arg.value);
        }
        continue;
      }
      if (next.value === '.') continue;
      const isStmtStart =
        !prev || prev.value === ';' || prev.value === '}' || prev.line < tok.line;
      if (!isStmtStart) continue;

      if (next.type === 'string') {
        specifiers.push(next.value);
        continue;
      }

      let j = i + 1;
      while (j < tokens.length) {
        const cur = tokens[j];
        if (cur.value === ';') break;
        if (cur.value === '{') {
          j = skipBalancedBraces(tokens, j);
          continue;
        }
        if (cur.type === 'ident' && cur.value === 'from' && tokens[j + 1]?.type === 'string') {
          specifiers.push(tokens[j + 1].value);
          break;
        }
        if (
          cur.type === 'ident' &&
          (cur.value === 'import' || cur.value === 'export') &&
          tokens[j - 1] &&
          tokens[j - 1].line < cur.line
        ) {
          break;
        }
        j++;
      }
      continue;
    }

    if (tok.value === 'export') {
      const isStmtStart =
        !prev || prev.value === ';' || prev.value === '}' || prev.line < tok.line;
      if (!isStmtStart) continue;

      let j = i + 1;
      if (tokens[j]?.type === 'ident' && tokens[j].value === 'type') j++;
      if (tokens[j]?.value === '*') {
        j++;
        if (tokens[j]?.type === 'ident' && tokens[j].value === 'as' && tokens[j + 1]?.type === 'ident') {
          j += 2;
        }
        if (tokens[j]?.type === 'ident' && tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') {
          specifiers.push(tokens[j + 1].value);
        }
      } else if (tokens[j]?.value === '{') {
        j = skipBalancedBraces(tokens, j);
        if (tokens[j]?.type === 'ident' && tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') {
          specifiers.push(tokens[j + 1].value);
        }
      }
    }
  }

  return specifiers.filter((s) => s.startsWith('.'));
}

function resolveRelativeImport(fromAbs: string, specifier: string): string | null {
  const rawTarget = path.resolve(path.dirname(fromAbs), specifier);
  const base = rawTarget.endsWith('.ts') ? rawTarget.slice(0, -3) : rawTarget;
  const candidates = [`${base}.ts`, path.join(base, 'index.ts')];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const rel = toRelPosix(candidate);
      if (!rel.startsWith('..')) return rel;
    }
  }
  return null;
}

function getLayer(rel: string): Layer {
  if (rel === 'types.ts') return 'types';
  if (rel === 'main.ts') return 'main';
  if (rel.startsWith('utils/')) return 'utils';
  if (rel.startsWith('core/')) return 'core';
  if (rel.startsWith('settings/')) return 'settings';
  if (rel.startsWith('api/')) return 'api';
  if (rel.startsWith('modules/')) return 'module';
  throw new Error(`Unrecognized src/ path layer: ${rel}`);
}

function getModuleName(rel: string): string {
  const rest = rel.slice('modules/'.length);
  const slash = rest.indexOf('/');
  if (slash !== -1) return rest.slice(0, slash);
  return rest.replace(/\.ts$/, '');
}

function isAllowedEdge(from: string, to: string): boolean {
  if (to === 'main.ts') return false;
  if (from === 'types.ts') return false;
  if (to === 'types.ts') return true;

  const fromLayer = getLayer(from);
  const toLayer = getLayer(to);

  switch (fromLayer) {
    case 'main':
      return toLayer !== 'module';
    case 'utils':
      return toLayer === 'utils';
    case 'core':
      if (toLayer === 'utils' || toLayer === 'core') return true;
      return from === 'core/registry.ts' && to === 'settings/settings.ts';
    case 'settings':
      if (from === 'settings/settings.ts') return toLayer === 'utils';
      return toLayer === 'utils' || toLayer === 'settings' || (toLayer === 'core' && to !== 'core/registry.ts');
    case 'api':
      return toLayer === 'utils' || toLayer === 'api' || (toLayer === 'core' && to !== 'core/registry.ts');
    case 'module':
      if (toLayer === 'utils' || toLayer === 'api') return true;
      if (to === 'core/registry.ts') return true;
      if (toLayer === 'module') return getModuleName(from) === getModuleName(to);
      return false;
    default:
      return false;
  }
}

describe('Architecture: Acyclic Layering DAG', () => {
  const files = collectTsFiles(SRC_ROOT);
  const edges = new Map<string, string[]>();

  for (const file of files) {
    const from = toRelPosix(file);
    const content = fs.readFileSync(file, 'utf8');
    const resolved = extractRelativeSpecifiers(content)
      .map((spec) => resolveRelativeImport(file, spec))
      .filter((target): target is string => target !== null);
    edges.set(from, [...new Set(resolved)].sort());
  }

  it('keeps src/types.ts as a zero-dependency leaf module within src/', () => {
    expect(edges.get('types.ts')).toEqual([]);
  });

  it('extracts imports accurately despite regex literals, multiline templates, and re-exports (BUG-87)', () => {
    const sample = `
      // import { Fake } from './commented';
      /* export * from './block-commented'; */
      const docExample = \`
        import { FakeTemplate } from './template-example';
        export { FakeReexport } from './template-reexport';
      \`;
      const quoted = "import { FakeQuoted } from './quoted-example'";
      const quoteRegex = /['"]/;
      import { RealAfterRegex } from './real-after-regex';
      export { Reexported } from './reexport-target';
      export type { TypeOnly } from './type-reexport';
      export * as ns from './star-reexport';
      const tplDyn = \`\${await import('./dynamic-in-template')}\`;
    `;
    expect(extractRelativeSpecifiers(sample)).toEqual([
      './real-after-regex',
      './reexport-target',
      './type-reexport',
      './star-reexport',
      './dynamic-in-template'
    ]);
  });

  it('matches the exact KNOWN_VIOLATIONS allowlist with no new or stale entries', () => {
    const actualViolations: string[] = [];
    for (const [from, targets] of edges.entries()) {
      for (const to of targets) {
        if (!isAllowedEdge(from, to)) {
          actualViolations.push(`${from} -> ${to}`);
        }
      }
    }
    actualViolations.sort();

    const knownSet = new Set(KNOWN_VIOLATIONS);
    const actualSet = new Set(actualViolations);

    const unexpected = actualViolations.filter((v) => !knownSet.has(v));
    const stale = KNOWN_VIOLATIONS.filter((v) => !actualSet.has(v));

    expect(unexpected, `Unexpected layering violations:\n${unexpected.join('\n')}`).toEqual([]);
    expect(stale, `Stale entries in KNOWN_VIOLATIONS (remove them!):\n${stale.join('\n')}`).toEqual([]);
  });

  it('keeps core/ and core/scopeLifecycle.ts completely free of import cycles (IMP-07)', () => {
    expect(edges.get('core/scopeLifecycle.ts')).toEqual(['types.ts', 'utils/helpers.ts']);
    expect(edges.get('core/modal.ts')).not.toContain('core/contextScope.ts');

    const coreFiles = [...edges.keys()].filter((f) => f.startsWith('core/'));
    const coreSet = new Set(coreFiles);
    const state = new Map<string, 'visiting' | 'visited'>();
    const stack: string[] = [];
    const cycles: string[] = [];

    const dfs = (node: string) => {
      state.set(node, 'visiting');
      stack.push(node);
      for (const next of edges.get(node) ?? []) {
        if (!coreSet.has(next)) continue;
        const nextState = state.get(next);
        if (nextState === 'visiting') {
          const idx = stack.indexOf(next);
          cycles.push([...stack.slice(idx), next].join(' -> '));
        } else if (!nextState) {
          dfs(next);
        }
      }
      stack.pop();
      state.set(node, 'visited');
    };

    for (const file of coreFiles) {
      if (!state.has(file)) dfs(file);
    }

    expect(cycles, `Import cycles detected in core/:\n${cycles.join('\n')}`).toEqual([]);
  });
});

describe('Architecture: Zero Import-Time Side Effects', () => {
  const TARGET_DIRS = ['modules', 'api', 'settings'] as const;
  const targetFiles = TARGET_DIRS.flatMap((dir) => collectTsFiles(path.join(SRC_ROOT, dir)))
    .map((abs) => toRelPosix(abs))
    .sort();

  // Pure-memory boot registrations in api/mal.ts and settings/devMode.ts (and transitive importers)
  const ALLOWED_ACCOUNT_IDS = new Set(['mal']);
  const ALLOWED_CORE_SETTING_KEYS = new Set(['devModeEnabled', 'debug']);

  it('imports every module, api, and settings file without GM_*, DOM, listener, timer, history, or fetch side effects (BUG-87)', async () => {
    const gmFns = [
      globalThis.GM_getValue,
      globalThis.GM_setValue,
      globalThis.GM_deleteValue,
      globalThis.GM_listValues,
      globalThis.GM_addValueChangeListener,
      globalThis.GM_removeValueChangeListener,
      globalThis.GM_xmlhttpRequest,
      globalThis.GM_registerMenuCommand,
      globalThis.GM_download
    ];

    for (const rel of targetFiles) {
      vi.resetModules();
      await import('../src/core/observer');
      if (rel !== 'settings/settings.ts') {
        await import('../src/core/registry');
      }
      const accounts = await import('../src/core/accounts');
      const settingsMod = rel !== 'settings/settings.ts' ? await import('../src/settings/settings') : null;

      for (const fn of gmFns) {
        if (fn?.mockClear) fn.mockClear();
      }
      const headBefore = document.head.innerHTML;
      const bodyBefore = document.body.innerHTML;
      const accountsBefore = accounts.listAccountProviders().map((p) => p.id);

      const winListenerSpy = vi.spyOn(window, 'addEventListener');
      const docListenerSpy = vi.spyOn(document, 'addEventListener');
      const intervalSpy = vi.spyOn(globalThis, 'setInterval');
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const winIntervalSpy = window.setInterval !== globalThis.setInterval ? vi.spyOn(window, 'setInterval') : null;
      const winTimeoutSpy = window.setTimeout !== globalThis.setTimeout ? vi.spyOn(window, 'setTimeout') : null;
      const pushStateSpy = vi.spyOn(history, 'pushState');
      const replaceStateSpy = vi.spyOn(history, 'replaceState');
      const fetchSpy = typeof globalThis.fetch === 'function' ? vi.spyOn(globalThis, 'fetch') : null;
      const winFetchSpy =
        typeof window.fetch === 'function' && window.fetch !== globalThis.fetch ? vi.spyOn(window, 'fetch') : null;
      const coreSettingSpy = settingsMod ? vi.spyOn(settingsMod.Settings, 'registerCoreSetting') : null;
      const featureRegisterSpy = settingsMod ? vi.spyOn(settingsMod.Settings, 'register') : null;

      try {
        await import(/* @vite-ignore */ `../src/${rel}`);

        for (const fn of gmFns) {
          expect(fn, `GM_* called while importing ${rel}`).not.toHaveBeenCalled();
        }
        expect(document.head.innerHTML, `head mutated while importing ${rel}`).toBe(headBefore);
        expect(document.body.innerHTML, `body mutated while importing ${rel}`).toBe(bodyBefore);
        expect(winListenerSpy, `window.addEventListener called while importing ${rel}`).not.toHaveBeenCalled();
        expect(docListenerSpy, `document.addEventListener called while importing ${rel}`).not.toHaveBeenCalled();
        expect(intervalSpy, `setInterval called while importing ${rel}`).not.toHaveBeenCalled();
        expect(timeoutSpy, `setTimeout called while importing ${rel}`).not.toHaveBeenCalled();
        if (winIntervalSpy) expect(winIntervalSpy, `window.setInterval called while importing ${rel}`).not.toHaveBeenCalled();
        if (winTimeoutSpy) expect(winTimeoutSpy, `window.setTimeout called while importing ${rel}`).not.toHaveBeenCalled();
        expect(pushStateSpy, `history.pushState called while importing ${rel}`).not.toHaveBeenCalled();
        expect(replaceStateSpy, `history.replaceState called while importing ${rel}`).not.toHaveBeenCalled();
        if (fetchSpy) expect(fetchSpy, `fetch called while importing ${rel}`).not.toHaveBeenCalled();
        if (winFetchSpy) expect(winFetchSpy, `window.fetch called while importing ${rel}`).not.toHaveBeenCalled();

        const newAccounts = accounts
          .listAccountProviders()
          .map((p) => p.id)
          .filter((id) => !accountsBefore.includes(id));
        const unexpectedAccounts = newAccounts.filter(
          (id) => !ALLOWED_ACCOUNT_IDS.has(id) || (rel.startsWith('api/') && rel !== 'api/mal.ts')
        );
        expect(unexpectedAccounts, `Unexpected account provider registration while importing ${rel}`).toEqual([]);

        if (coreSettingSpy) {
          const registeredKeys = coreSettingSpy.mock.calls.map((c) => c[0]?.key);
          const unexpectedCoreKeys = registeredKeys.filter(
            (key) =>
              !ALLOWED_CORE_SETTING_KEYS.has(key) ||
              (rel.startsWith('settings/') && rel !== 'settings/devMode.ts' && rel !== 'settings/panel.ts')
          );
          expect(unexpectedCoreKeys, `Unexpected Settings.registerCoreSetting while importing ${rel}`).toEqual([]);
        }
        if (featureRegisterSpy && !rel.startsWith('modules/')) {
          expect(featureRegisterSpy, `Unexpected Settings.register while importing ${rel}`).not.toHaveBeenCalled();
        }
      } finally {
        winListenerSpy.mockRestore();
        docListenerSpy.mockRestore();
        intervalSpy.mockRestore();
        timeoutSpy.mockRestore();
        winIntervalSpy?.mockRestore();
        winTimeoutSpy?.mockRestore();
        pushStateSpy.mockRestore();
        replaceStateSpy.mockRestore();
        fetchSpy?.mockRestore();
        winFetchSpy?.mockRestore();
        coreSettingSpy?.mockRestore();
        featureRegisterSpy?.mockRestore();
      }
    }
  });

  it('guards observer history patching with a global symbol and lazily starts/stops nav listeners and 400ms interval (BUG-87)', async () => {
    vi.resetModules();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const addListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeListenerSpy = vi.spyOn(window, 'removeEventListener');

    try {
      const obs1 = await import('../src/core/observer');
      const pushRef1 = window.history.pushState;
      const replaceRef1 = window.history.replaceState;

      // Importing observer without subscribers must not start polling or window listeners
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(addListenerSpy).not.toHaveBeenCalled();

      // Re-importing after vi.resetModules() must not stack history wrappers
      vi.resetModules();
      const obs2 = await import('../src/core/observer');
      expect(window.history.pushState).toBe(pushRef1);
      expect(window.history.replaceState).toBe(replaceRef1);
      expect(setIntervalSpy).not.toHaveBeenCalled();

      // Subscribing lazily attaches popstate/hashchange and the 400ms interval; unsubscribing cleans them up
      const navCb = vi.fn();
      const unsub1 = obs2.Core.onNavigate(navCb);
      const unsub2 = obs2.Core.onNavigate(() => {});
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 400);
      expect(addListenerSpy).toHaveBeenCalledWith('popstate', expect.any(Function));
      expect(addListenerSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));

      unsub1();
      expect(clearIntervalSpy).not.toHaveBeenCalled();
      unsub2();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(removeListenerSpy).toHaveBeenCalledWith('popstate', expect.any(Function));
      expect(removeListenerSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));

      // Even if a prior module instance left an active nav watcher before vi.resetModules(), re-importing clears it
      obs2.Core.onNavigate(() => {});
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      vi.resetModules();
      await import('../src/core/observer');
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
      void obs1;
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      addListenerSpy.mockRestore();
      removeListenerSpy.mockRestore();
    }
  });
});
