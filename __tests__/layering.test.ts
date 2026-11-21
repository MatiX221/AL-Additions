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

function stripCommentsAndStringsForImports(source: string): string {
  let out = '';
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < len) {
        const c = source[i];
        out += c;
        if (c === '\\') {
          i++;
          if (i < len) out += source[i];
        } else if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function extractRelativeSpecifiers(source: string): string[] {
  const cleaned = stripCommentsAndStringsForImports(source);
  const specifiers: string[] = [];

  const staticRe = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\s+from\s+)?(['"])([^'"]+)\1/gm;
  for (const m of cleaned.matchAll(staticRe)) {
    specifiers.push(m[2]);
  }

  const dynamicRe = /(?<![.\w])import\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const m of cleaned.matchAll(dynamicRe)) {
    specifiers.push(m[2]);
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
      if (to === 'settings/settings.ts') return true;
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
});

describe('Architecture: Zero Import-Time Side Effects', () => {
  const MODULES_ROOT = path.join(SRC_ROOT, 'modules');
  const moduleDirs = fs
    .readdirSync(MODULES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(MODULES_ROOT, d.name, 'index.ts')))
    .map((d) => d.name)
    .sort();

  it('imports every module entrypoint without GM_*, DOM, style, or listener side effects', async () => {
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

    for (const dir of moduleDirs) {
      vi.resetModules();
      await import('../src/core/observer');
      await import('../src/core/registry');

      for (const fn of gmFns) {
        if (fn?.mockClear) fn.mockClear();
      }
      const headBefore = document.head.innerHTML;
      const bodyBefore = document.body.innerHTML;
      const winSpy = vi.spyOn(window, 'addEventListener');
      const docSpy = vi.spyOn(document, 'addEventListener');

      try {
        await import(/* @vite-ignore */ `../src/modules/${dir}/index.ts`);

        for (const fn of gmFns) {
          expect(fn, `GM_* called while importing modules/${dir}`).not.toHaveBeenCalled();
        }
        expect(document.head.innerHTML, `head mutated while importing modules/${dir}`).toBe(headBefore);
        expect(document.body.innerHTML, `body mutated while importing modules/${dir}`).toBe(bodyBefore);
        expect(winSpy, `window.addEventListener called while importing modules/${dir}`).not.toHaveBeenCalled();
        expect(docSpy, `document.addEventListener called while importing modules/${dir}`).not.toHaveBeenCalled();
      } finally {
        winSpy.mockRestore();
        docSpy.mockRestore();
      }
    }
  });
});
