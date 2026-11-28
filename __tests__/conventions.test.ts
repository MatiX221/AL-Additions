import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC_ROOT = path.resolve(process.cwd(), 'src');

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
  return results.sort();
}

function toRelPosix(absPath: string): string {
  return path.relative(SRC_ROOT, absPath).replace(/\\/g, '/');
}

interface CommentEntry {
  text: string;
  line: number;
  start: number;
  end: number;
}

const REGEX_PREV_KEYWORDS = new Set([
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

function isRegexStart(source: string, slashIdx: number): boolean {
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(source[j])) j--;
  if (j < 0) return true;
  const prev = source[j];
  if (prev === '+' && source[j - 1] === '+') return false;
  if (prev === '-' && source[j - 1] === '-') return false;
  if ('([{},;:?=!&|^~+-*%<>'.includes(prev)) return true;
  if (/[a-zA-Z0-9_$]/.test(prev)) {
    let start = j;
    while (start > 0 && /[a-zA-Z0-9_$]/.test(source[start - 1])) start--;
    return REGEX_PREV_KEYWORDS.has(source.slice(start, j + 1));
  }
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

function scanSource(
  source: string,
  options: { preserveStrings: boolean; blankTemplateText?: boolean }
): { code: string; comments: CommentEntry[] } {
  const comments: CommentEntry[] = [];
  let out = '';
  let i = 0;
  let line = 1;
  const len = source.length;
  let braceDepth = 0;
  const templateBraceStack: number[] = [];

  const blankPreservingNewlines = (slice: string): string => slice.replace(/[^\n]/g, ' ');

  const scanTemplateSegment = (): void => {
    while (i < len) {
      const c = source[i];
      if (c === '\n') {
        line++;
        out += '\n';
        i++;
        continue;
      }
      if (c === '\\') {
        const nextChar = i + 1 < len ? source[i + 1] : '';
        if (nextChar === '\n') line++;
        const rawEsc = source.slice(i, i + 2);
        out += options.preserveStrings && !options.blankTemplateText ? rawEsc : blankPreservingNewlines(rawEsc);
        i += 2;
        continue;
      }
      if (c === '`') {
        out += '`';
        i++;
        return;
      }
      if (c === '$' && source[i + 1] === '{') {
        out += '${';
        i += 2;
        braceDepth++;
        templateBraceStack.push(braceDepth);
        return;
      }
      out += options.preserveStrings && !options.blankTemplateText ? c : ' ';
      i++;
    }
  };

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '\n') {
      line++;
      out += '\n';
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const start = i;
      const startLine = line;
      i += 2;
      const textStart = i;
      while (i < len && source[i] !== '\n') i++;
      comments.push({ text: source.slice(textStart, i), line: startLine, start, end: i });
      out += ' '.repeat(i - start);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      const startLine = line;
      i += 2;
      const textStart = i;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      const textEnd = i;
      if (i < len) i += 2;
      comments.push({ text: source.slice(textStart, textEnd), line: startLine, start, end: i });
      out += blankPreservingNewlines(source.slice(start, i));
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      i++;
      while (i < len) {
        const c = source[i];
        if (c === '\n') line++;
        if (c === '\\') {
          const nextChar = i + 1 < len ? source[i + 1] : '';
          if (nextChar === '\n') line++;
          const rawEsc = source.slice(i, i + 2);
          out += options.preserveStrings ? rawEsc : blankPreservingNewlines(rawEsc);
          i += 2;
          continue;
        }
        if (c === quote) {
          out += quote;
          i++;
          break;
        }
        out += options.preserveStrings || c === '\n' ? c : ' ';
        i++;
      }
      continue;
    }
    if (ch === '`') {
      out += '`';
      i++;
      scanTemplateSegment();
      continue;
    }
    if (ch === '/' && isRegexStart(source, i)) {
      const end = findRegexEnd(source, i);
      if (end !== -1) {
        const rawRe = source.slice(i, end);
        out += options.preserveStrings ? rawRe : '/' + ' '.repeat(Math.max(0, rawRe.length - 2)) + '/';
        i = end;
        continue;
      }
    }
    if (ch === '{') {
      braceDepth++;
      out += ch;
      i++;
      continue;
    }
    if (ch === '}') {
      if (templateBraceStack.length > 0 && templateBraceStack[templateBraceStack.length - 1] === braceDepth) {
        templateBraceStack.pop();
        braceDepth--;
        out += '}';
        i++;
        scanTemplateSegment();
        continue;
      }
      braceDepth = Math.max(0, braceDepth - 1);
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }

  return { code: out, comments };
}

function stripCommentsPreservingStrings(source: string): string {
  return scanSource(source, { preserveStrings: true }).code;
}

function maskCommentsStringsAndRegexes(source: string): string {
  return scanSource(source, { preserveStrings: false, blankTemplateText: true }).code;
}

function extractComments(source: string): CommentEntry[] {
  return scanSource(source, { preserveStrings: true }).comments;
}

function normalizeGlobalCasts(code: string, identPattern: string): string {
  let normalized = code;
  const castRe = new RegExp(`\\(\\s*(${identPattern})(?:\\s+(?:as|satisfies)\\s+[^()]+)+\\s*\\)`, 'g');
  let prev = '';
  while (normalized !== prev) {
    prev = normalized;
    normalized = normalized.replace(castRe, '$1');
  }
  return normalized;
}

function hasAnilistValueImport(source: string): boolean {
  const code = stripCommentsPreservingStrings(source);
  const anilistSpecRe = /(?:^|\/)api\/anilist(?:\.ts)?$/;

  // Match static import declarations (type-only vs value/namespace/mixed)
  const importStmtRe = /(?:^|[;\n}])\s*import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g;
  for (const m of code.matchAll(importStmtRe)) {
    const clause = m[1].trim();
    const spec = m[3];
    if (!anilistSpecRe.test(spec)) continue;

    // Pure `import type Foo`, `import type { ... }`, `import type * as ns` are allowed
    if (/^type\s+(?:\{|\*|[A-Za-z_$])/.test(clause)) continue;

    // Named import `{ ... }`: allow only if every non-empty specifier starts with `type `
    if (clause.startsWith('{') && clause.endsWith('}')) {
      const inner = clause.slice(1, -1).trim();
      if (!inner) continue;
      const specifiers = inner
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const allTypeOnly = specifiers.every((s) => /^type\s+/.test(s));
      if (allTypeOnly) continue;
    }

    return true;
  }

  // Side-effect `import '.../api/anilist'`
  const sideEffectRe = /(?:^|[;\n}])\s*import\s+(['"])([^'"]+)\1/g;
  for (const m of code.matchAll(sideEffectRe)) {
    if (anilistSpecRe.test(m[2])) return true;
  }

  // Runtime dynamic `import('.../api/anilist')` (skip TS type annotations like `: import('...').Type`)
  const dynamicRe = /(?<![.\w])import\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const m of code.matchAll(dynamicRe)) {
    if (!anilistSpecRe.test(m[2])) continue;
    const before = code.slice(0, m.index ?? 0).trimEnd();
    if (/[:<|&\btype\b=]$/.test(before) || /\btypeof$/.test(before)) continue;
    return true;
  }

  return false;
}

function hasGlobalAddEventListener(source: string): boolean {
  const code = normalizeGlobalCasts(
    stripCommentsPreservingStrings(source),
    'window|document|globalThis|unsafeWindow'
  );
  return /\b(?:window|document|globalThis|unsafeWindow)\s*(?:\?\.)?\s*(?:\.\s*addEventListener\s*\(|\[\s*['"`]addEventListener['"`]\s*\]\s*\()/.test(
    code
  );
}

function findMatchingDelimiter(code: string, openIdx: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function hasLegacyStyleOrMountId(source: string): boolean {
  const codeWithStrings = stripCommentsPreservingStrings(source);
  if (/\baddStyle\s*\(\s*['"`](?:ala|daiya|almal)-/.test(codeWithStrings)) return true;

  const masked = maskCommentsStringsAndRegexes(source);
  const callRe = /\b(?:mount|modal)\s*\(\s*\{/g;
  for (const m of masked.matchAll(callRe)) {
    const openBrace = masked.indexOf('{', m.index ?? 0);
    if (openBrace === -1) continue;
    const closeBrace = findMatchingDelimiter(masked, openBrace, '{', '}');
    if (closeBrace === -1) continue;

    // Extract only depth-1 text of the options object so nested `{}` blocks in callbacks don't hide `id`
    let topLevel = '';
    let depth = 0;
    for (let i = openBrace; i <= closeBrace; i++) {
      const ch = masked[i];
      if (ch === '{') {
        depth++;
        if (depth === 1) topLevel += '{';
      } else if (ch === '}') {
        if (depth === 1) topLevel += '}';
        depth--;
      } else if (depth === 1) {
        topLevel += codeWithStrings[i];
      }
    }

    if (/(?:^|[{,\s])id\s*:\s*['"`](?:ala|daiya|almal)-/.test(topLevel)) {
      return true;
    }
  }

  return false;
}

function hasRawConsoleCall(source: string): boolean {
  const code = normalizeGlobalCasts(stripCommentsPreservingStrings(source), 'console');
  return /\bconsole\s*(?:\?\.)?\s*(?:\.\s*(?:log|debug|warn|error)\b|\[)/.test(code);
}

function hasRawMutationObserver(source: string): boolean {
  const code = stripCommentsPreservingStrings(source);
  return /\bnew\s+(?:(?:window|globalThis|self|unsafeWindow)\s*\.\s*)?MutationObserver\b/.test(code);
}

interface MigrateDecl {
  declStart: number;
  bodyStart: number;
  bodyEnd: number;
  line: number;
}

function skipBalancedAndOptionalType(masked: string, openParenIdx: number): number {
  const closeParen = findMatchingDelimiter(masked, openParenIdx, '(', ')');
  if (closeParen === -1) return -1;
  let idx = closeParen + 1;
  while (idx < masked.length && /\s/.test(masked[idx])) idx++;
  if (masked[idx] === ':') {
    idx++;
    let paren = 0;
    let angle = 0;
    let brace = 0;
    let bracket = 0;
    while (idx < masked.length) {
      const ch = masked[idx];
      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '[') bracket++;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
      else if (ch === '<') angle++;
      else if (ch === '>' && masked[idx - 1] !== '=') angle = Math.max(0, angle - 1);
      else if (paren === 0 && bracket === 0 && angle === 0 && brace === 0) {
        if (ch === '{' || (ch === '=' && masked[idx + 1] === '>')) break;
        if (ch === ';' || ch === ',') return -1;
      }
      if (ch === '{') brace++;
      else if (ch === '}') brace = Math.max(0, brace - 1);
      idx++;
    }
  }
  return idx;
}

function findConciseArrowEnd(masked: string, start: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace++;
    else if (ch === '}') {
      if (paren === 0 && bracket === 0 && brace === 0) return i;
      brace = Math.max(0, brace - 1);
    } else if ((ch === ',' || ch === ';') && paren === 0 && bracket === 0 && brace === 0) {
      return i;
    }
  }
  return masked.length;
}

function lineAt(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function findMigrateDeclarations(source: string): MigrateDecl[] {
  const masked = maskCommentsStringsAndRegexes(source);
  const decls: MigrateDecl[] = [];
  const seenBodyStarts = new Set<number>();

  const addDecl = (declStart: number, bodyStart: number, bodyEnd: number) => {
    if (seenBodyStarts.has(bodyStart)) return;
    seenBodyStarts.add(bodyStart);
    decls.push({ declStart, bodyStart, bodyEnd, line: lineAt(source, declStart) });
  };

  // 1. Named function declarations: `(async) function migrate*(...) { ... }`
  const fnRe = /\b(?:async\s+)?function\s+migrate[A-Za-z0-9_]*\s*\(/g;
  for (const m of masked.matchAll(fnRe)) {
    const start = m.index ?? 0;
    const parenIdx = masked.indexOf('(', start);
    const afterSig = skipBalancedAndOptionalType(masked, parenIdx);
    if (afterSig !== -1 && masked[afterSig] === '{') {
      const end = findMatchingDelimiter(masked, afterSig, '{', '}');
      if (end !== -1) addDecl(start, afterSig, end);
    }
  }

  // 2. Variable function/arrow declarations: `(const|let|var) migrate* = ...`
  const varRe = /\b(?:const|let|var)\s+migrate[A-Za-z0-9_]*\b[^=;\n]*=\s*/g;
  for (const m of masked.matchAll(varRe)) {
    const start = m.index ?? 0;
    let idx = start + m[0].length;
    if (masked.slice(idx).startsWith('async')) {
      const afterAsync = idx + 5;
      if (/\s/.test(masked[afterAsync] || '')) {
        idx = afterAsync;
        while (idx < masked.length && /\s/.test(masked[idx])) idx++;
      }
    }
    if (masked.slice(idx).startsWith('function') && /[\s(*]/.test(masked[idx + 8] || '')) {
      const pIdx = masked.indexOf('(', idx);
      if (pIdx !== -1) {
        const afterSig = skipBalancedAndOptionalType(masked, pIdx);
        if (afterSig !== -1 && masked[afterSig] === '{') {
          const end = findMatchingDelimiter(masked, afterSig, '{', '}');
          if (end !== -1) addDecl(start, afterSig, end);
        }
      }
    } else if (masked[idx] === '(') {
      const afterSig = skipBalancedAndOptionalType(masked, idx);
      if (afterSig !== -1 && masked.slice(afterSig, afterSig + 2) === '=>') {
        let bodyIdx = afterSig + 2;
        while (bodyIdx < masked.length && /\s/.test(masked[bodyIdx])) bodyIdx++;
        if (masked[bodyIdx] === '{') {
          const end = findMatchingDelimiter(masked, bodyIdx, '{', '}');
          if (end !== -1) addDecl(start, bodyIdx, end);
        } else {
          addDecl(start, bodyIdx, findConciseArrowEnd(masked, bodyIdx));
        }
      }
    } else {
      const singleParam = masked.slice(idx).match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*/);
      if (singleParam) {
        const bodyIdx = idx + singleParam[0].length;
        if (masked[bodyIdx] === '{') {
          const end = findMatchingDelimiter(masked, bodyIdx, '{', '}');
          if (end !== -1) addDecl(start, bodyIdx, end);
        } else {
          addDecl(start, bodyIdx, findConciseArrowEnd(masked, bodyIdx));
        }
      }
    }
  }

  // 3. Method hooks: `(async) migrate(...) { ... }`
  const methodRe = /(?:^|[{,;\n])\s*(?:(?:public|private|protected|static|readonly)\s+)*(?:async\s+)?migrate\s*\(/g;
  for (const m of masked.matchAll(methodRe)) {
    const matchStart = m.index ?? 0;
    const kwOffset = m[0].search(/(?:async|migrate)\b/);
    const declStart = matchStart + Math.max(0, kwOffset);
    const parenIdx = masked.indexOf('(', declStart);
    const afterSig = skipBalancedAndOptionalType(masked, parenIdx);
    if (afterSig !== -1 && masked[afterSig] === '{') {
      const end = findMatchingDelimiter(masked, afterSig, '{', '}');
      if (end !== -1) addDecl(declStart, afterSig, end);
    }
  }

  // 4. Property hooks: `migrate: (async) (...) => ...` or `migrate: (async) function(...) { ... }`
  const propRe = /(?:^|[{,\n])\s*migrate\s*:\s*/g;
  for (const m of masked.matchAll(propRe)) {
    const matchStart = m.index ?? 0;
    const declStart = matchStart + Math.max(0, m[0].indexOf('migrate'));
    let idx = matchStart + m[0].length;
    if (masked.slice(idx).startsWith('async') && /\s/.test(masked[idx + 5] || '')) {
      idx += 5;
      while (idx < masked.length && /\s/.test(masked[idx])) idx++;
    }
    if (masked.slice(idx).startsWith('function') && /[\s(*]/.test(masked[idx + 8] || '')) {
      const pIdx = masked.indexOf('(', idx);
      if (pIdx !== -1) {
        const afterSig = skipBalancedAndOptionalType(masked, pIdx);
        if (afterSig !== -1 && masked[afterSig] === '{') {
          const end = findMatchingDelimiter(masked, afterSig, '{', '}');
          if (end !== -1) addDecl(declStart, afterSig, end);
        }
      }
    } else if (masked[idx] === '(') {
      const afterSig = skipBalancedAndOptionalType(masked, idx);
      if (afterSig !== -1 && masked.slice(afterSig, afterSig + 2) === '=>') {
        let bodyIdx = afterSig + 2;
        while (bodyIdx < masked.length && /\s/.test(masked[bodyIdx])) bodyIdx++;
        if (masked[bodyIdx] === '{') {
          const end = findMatchingDelimiter(masked, bodyIdx, '{', '}');
          if (end !== -1) addDecl(declStart, bodyIdx, end);
        } else {
          addDecl(declStart, bodyIdx, findConciseArrowEnd(masked, bodyIdx));
        }
      }
    } else {
      const singleParam = masked.slice(idx).match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*/);
      if (singleParam) {
        const bodyIdx = idx + singleParam[0].length;
        if (masked[bodyIdx] === '{') {
          const end = findMatchingDelimiter(masked, bodyIdx, '{', '}');
          if (end !== -1) addDecl(declStart, bodyIdx, end);
        } else {
          addDecl(declStart, bodyIdx, findConciseArrowEnd(masked, bodyIdx));
        }
      }
    }
  }

  return decls.sort((a, b) => a.declStart - b.declStart);
}

const VALID_MIGRATION_TAG_RE =
  /@migration\(\s*from:\s*"([^"]+)"\s*,\s*kind:\s*"(storage|import|cleanup)"\s*,\s*sunset:\s*"([^"]+)"\s*\)/g;

function hasValidMigrationTag(commentText: string): boolean {
  VALID_MIGRATION_TAG_RE.lastIndex = 0;
  const matches = [...commentText.matchAll(VALID_MIGRATION_TAG_RE)];
  return (
    matches.length > 0 &&
    matches.every((m) => m[1].trim().length > 0 && m[3].trim().length > 0)
  );
}

function findMissingMigrationTags(source: string): number[] {
  const decls = findMigrateDeclarations(source);
  if (decls.length === 0) return [];
  const masked = maskCommentsStringsAndRegexes(source);
  const validComments = extractComments(source).filter((c) => hasValidMigrationTag(c.text));

  const missingLines: number[] = [];
  for (const decl of decls) {
    const hasTag = validComments.some((c) => {
      if (c.start >= decl.bodyStart && c.end <= decl.bodyEnd) return true;
      if (c.end <= decl.declStart) {
        const between = masked.slice(c.end, decl.declStart);
        if (/^(?:\s|export\b)*$/.test(between)) return true;
      }
      return false;
    });
    if (!hasTag) missingLines.push(decl.line);
  }
  return missingLines;
}

const ALL_FILES = collectTsFiles(SRC_ROOT).map((abs) => ({
  abs,
  rel: toRelPosix(abs),
  raw: fs.readFileSync(abs, 'utf8')
}));

describe('Conventions: Module Encapsulation & Raw Access Guards', () => {
  const moduleFiles = ALL_FILES.filter((f) => f.rel.startsWith('modules/'));

  const FORBIDDEN_MODULE_PATTERNS: Array<{
    name: string;
    re: RegExp;
    allow?: Set<string> | ((rel: string) => boolean);
  }> = [
    { name: "raw session/auth key ('al_user_id')", re: /['"`]al_user_id['"`]/ },
    { name: "raw session/auth key ('al_username')", re: /['"`]al_username['"`]/ },
    { name: "raw session/auth key ('al_score_format')", re: /['"`]al_score_format['"`]/ },
    { name: "raw session/auth key ('al_token_auth')", re: /['"`]al_token_auth['"`]/ },
    { name: "raw session/auth key ('al_token')", re: /['"`]al_token['"`]/ },
    { name: "raw MAL token key ('mal_token')", re: /['"`]mal_token['"`]/ },
    { name: 'ctx.api.session bypass (use ctx.session)', re: /\bctx\.api\.session\b/ },
    { name: 'ANILIST_SESSION_KEYS in module', re: /\bANILIST_SESSION_KEYS\b/ },
    { name: 'SETTING_PREFIX in module', re: /\bSETTING_PREFIX\b/ },
    {
      name: 'hardcoded ala_setting_ prefix in module',
      re: /['"`]ala_setting_/
    },
    {
      name: 'hardcoded ala_mod_ prefix in module',
      re: /['"`]ala_mod_/
    },
    {
      name: 'importing PREFIX from settings/settings',
      re: /import\s*\{[^}]*\bPREFIX\b[^}]*\}\s*from\s*['"][^'"]*settings\/settings['"]/
    },
    {
      name: 'direct Settings import/access in module (use ctx.get / ctx.set)',
      re: /from\s*['"][^'"]*settings\/settings['"]|\bSettings\.(?:get|set|has|register|migrate)\b/
    },
    {
      name: 'raw GM_* API call in module',
      re: /\bGM_(?:download|xmlhttpRequest|getValue|setValue|deleteValue|listValues|addValueChangeListener|removeValueChangeListener|registerMenuCommand)\b/
    },
    {
      name: 'raw persistent() usage in module (use ctx.persistent)',
      re: /import\s*\{[^}]*\bpersistent\b[^}]*\}\s*from\s*['"][^'"]*utils\/helpers['"]|(?<!\.)\bpersistent\s*\(/
    },
    {
      name: 'raw store / jsonGet / jsonSet usage in module (use ctx.storage)',
      re: /import\s*\{[^}]*\b(?:store|jsonGet|jsonSet)\b[^}]*\}\s*from\s*['"][^'"]*utils\/helpers['"]|(?<!\.)\b(?:jsonGet|jsonSet)\s*\(/
    },
    {
      name: 'raw gm / downloadFile usage in module (use ctx.http)',
      re: /import\s*\{[^}]*\b(?:gm|downloadFile)\b[^}]*\}\s*from\s*['"][^'"]*utils\/helpers['"]|\bgm\.(?:request|text|json)\s*\(|\bdownloadFile\s*\(/
    },
    {
      name: 'raw localStorage / sessionStorage access in module (use ctx.storage)',
      re: /\b(?:localStorage|sessionStorage)\b/
    },
    { name: 'legacy ctx.debug usage (use ctx.log)', re: /\bctx\.debug\b/ },
    { name: 'removed logDebug helper', re: /\blogDebug\b/ },
    { name: 'removed isDebug helper', re: /\bisDebug\b/ },
    { name: 'removed registerDebugChannel helper', re: /\bregisterDebugChannel\b/ },
    { name: 'createCoreLogger in feature module (use ctx.log)', re: /\bcreateCoreLogger\b/ },
    {
      name: 'internal logger helpers in module (use ctx.log)',
      re: /\b(?:createLogger|isDebugEnabled|getDebuggableChannels)\b/
    },
    {
      name: 'raw setTimeout / setInterval in module (use ctx.timeout / ctx.interval / rc.timeout / rc.interval)',
      re: /\b(?:setTimeout|setInterval)\s*\(/,
      allow: new Set([
        'modules/fastLoad/config.ts',
        'modules/fastLoad/domOptimizers.ts',
        'modules/fastLoad/worker.ts',
        'modules/sync/state.ts'
      ])
    }
  ];

  it('forbids raw keys, prefixes, GM_* APIs, and legacy/core logging bypasses in src/modules/**', () => {
    const violations: string[] = [];

    for (const file of moduleFiles) {
      const code = stripCommentsPreservingStrings(file.raw);
      for (const rule of FORBIDDEN_MODULE_PATTERNS) {
        if (typeof rule.allow === 'function' ? rule.allow(file.rel) : rule.allow?.has(file.rel)) continue;
        if (rule.re.test(code)) {
          violations.push(`${file.rel}: ${rule.name}`);
        }
      }
      if (hasAnilistValueImport(file.raw)) {
        violations.push(`${file.rel}: direct value/namespace import from api/anilist (use ctx.api; import type is allowed)`);
      }
      if (hasGlobalAddEventListener(file.raw)) {
        violations.push(`${file.rel}: raw window/document/globalThis/unsafeWindow addEventListener (use ctx.listen / rc.listen)`);
      }
      if (hasLegacyStyleOrMountId(file.raw)) {
        violations.push(`${file.rel}: hardcoded legacy style, mount, or modal ID prefix (use ctx.getId / ctx.addStyle)`);
      }
    }

    expect(violations, `Module convention violations:\n${violations.join('\n')}`).toEqual([]);
  });

  it('forbids raw new MutationObserver under src/modules/** except fastLoad/domOptimizers.ts (IMP-04)', () => {
    const allow = new Set(['modules/fastLoad/domOptimizers.ts']);
    const violations: string[] = [];

    for (const file of moduleFiles) {
      if (allow.has(file.rel)) continue;
      if (hasRawMutationObserver(file.raw)) {
        violations.push(`${file.rel}: raw new MutationObserver (use ctx.observe / rc.observe)`);
      }
    }

    expect(violations, `Raw MutationObserver violations:\n${violations.join('\n')}`).toEqual([]);
    expect(hasRawMutationObserver(`new MutationObserver(cb);`)).toBe(true);
    expect(hasRawMutationObserver(`new window.MutationObserver(cb);`)).toBe(true);
    expect(hasRawMutationObserver(`rc.observe(document.body, { attributes: true }, cb);`)).toBe(false);
  });

  it('forbids raw console.log/debug/warn/error and console[...] bracket calls across core, settings, api, and modules', () => {
    const guarded = ALL_FILES.filter(
      (f) =>
        f.rel.startsWith('core/') ||
        f.rel.startsWith('settings/') ||
        f.rel.startsWith('api/') ||
        f.rel.startsWith('modules/')
    );
    const violations: string[] = [];

    for (const file of guarded) {
      if (hasRawConsoleCall(file.raw)) {
        violations.push(`${file.rel}: raw console.{log,debug,warn,error}() or console[...] call`);
      }
    }

    expect(violations, `Raw console.* violations:\n${violations.join('\n')}`).toEqual([]);
  });

  it('catches TS/JS bypass forms in strengthened convention guards (BUG-88)', () => {
    expect(hasAnilistValueImport(`import { anilistApiClient } from '../../api/anilist';`)).toBe(true);
    expect(hasAnilistValueImport(`import { MediaData } from '../../api/anilist';`)).toBe(true);
    expect(hasAnilistValueImport(`import * as al from '../../api/anilist';`)).toBe(true);
    expect(hasAnilistValueImport(`import { type MediaListResult, anilistApiClient } from '../../api/anilist';`)).toBe(true);
    expect(hasAnilistValueImport(`import type { MediaListResult, MediaData } from '../../api/anilist';`)).toBe(false);
    expect(hasAnilistValueImport(`import { type MediaListResult, type ViewerInfo } from '../../api/anilist';`)).toBe(false);

    expect(hasGlobalAddEventListener(`globalThis.addEventListener('click', fn);`)).toBe(true);
    expect(hasGlobalAddEventListener(`unsafeWindow.addEventListener('message', fn);`)).toBe(true);
    expect(hasGlobalAddEventListener(`(window as any).addEventListener('scroll', fn);`)).toBe(true);
    expect(hasGlobalAddEventListener(`(globalThis as any)['addEventListener']('popstate', fn);`)).toBe(true);
    expect(hasGlobalAddEventListener(`button.addEventListener('click', fn);`)).toBe(false);

    expect(
      hasLegacyStyleOrMountId(`ctx.mount({ anchor: () => { return document.body; }, id: 'ala-bad' });`)
    ).toBe(true);
    expect(hasLegacyStyleOrMountId(`ctx.modal({ title: 'X', id: 'ala-modal-bad' });`)).toBe(true);
    expect(hasLegacyStyleOrMountId(`ctx.mount({ anchor: () => { return document.body; }, id: 'good-id' });`)).toBe(false);

    expect(hasRawConsoleCall(`console['warn']('oops');`)).toBe(true);
    expect(hasRawConsoleCall(`console[level]('oops');`)).toBe(true);
    expect(hasRawConsoleCall(`(console as any).log('oops');`)).toBe(true);
    expect(hasRawConsoleCall(`coreLog.warn('ok');`)).toBe(false);
  });
});

describe('Conventions: @migration Annotation Validation', () => {
  it('validates every @migration(...) tag syntax and fields across src/**', () => {
    const violations: string[] = [];
    let totalTags = 0;

    for (const file of ALL_FILES) {
      const comments = extractComments(file.raw);
      for (const c of comments) {
        if (!c.text.includes('@migration')) continue;
        VALID_MIGRATION_TAG_RE.lastIndex = 0;
        const matches = [...c.text.matchAll(VALID_MIGRATION_TAG_RE)];
        if (matches.length === 0) {
          violations.push(`${file.rel}:${c.line}: malformed @migration tag -> ${c.text.trim()}`);
          continue;
        }
        for (const m of matches) {
          totalTags++;
          const from = m[1].trim();
          const sunset = m[3].trim();
          if (!from) violations.push(`${file.rel}:${c.line}: empty "from" in @migration`);
          if (!sunset) violations.push(`${file.rel}:${c.line}: empty "sunset" in @migration`);
        }
      }
    }

    expect(totalTags).toBeGreaterThan(0);
    expect(violations, `Invalid @migration tags:\n${violations.join('\n')}`).toEqual([]);
  });

  it('requires every migrate hook/declaration individually to carry an adjacent or in-body @migration tag (BUG-88)', () => {
    const violations: string[] = [];

    for (const file of ALL_FILES) {
      if (file.rel === 'types.ts' || file.rel === 'core/registry.ts' || file.rel === 'main.ts') continue;
      for (const line of findMissingMigrationTags(file.raw)) {
        violations.push(`${file.rel}:${line}: defines migrate hook/helper without an adjacent or in-body @migration(...) annotation`);
      }
    }

    expect(violations, `Missing @migration annotations:\n${violations.join('\n')}`).toEqual([]);

    // Per-function validation checks each declaration independently and allows helper references / private helpers
    const multiHookMissingSecond = `
      const mod1 = {
        migrate(m) {
          // @migration(from: "v0.8.0", kind: "storage", sunset: "keep-long")
          m.storage.get('a', null);
        }
      };
      const mod2 = {
        async migrate(m) {
          m.storage.get('b', null);
        }
      };
    `;
    expect(findMissingMigrationTags(multiHookMissingSecond)).toHaveLength(1);
    expect(findMissingMigrationTags(`const m = { migrate: (x) => x.storage.get('a', null) };`)).toHaveLength(1);
    expect(findMissingMigrationTags(`const migrateLegacy = (m) => { m.storage.get('a', null); };`)).toHaveLength(1);
    expect(
      findMissingMigrationTags(`
        // @migration(from: "v0.8.0", kind: "storage", sunset: "keep-long")
        const migrateLegacy = (m) => { m.storage.get('a', null); };
        const privateHelper = () => {};
        const mod = { migrate: migrateLegacy };
      `)
    ).toEqual([]);
  });
});