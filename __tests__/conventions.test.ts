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

const REGEX_PREV_KEYWORDS = new Set([
  'return', 'case', 'throw', 'in', 'of', 'typeof', 'void', 'delete', 'new', 'yield', 'await', 'else', 'do'
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

function stripCommentsPreservingStrings(source: string): string {
  let out = '';
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
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
    if (ch === '/' && isRegexStart(source, i)) {
      const end = findRegexEnd(source, i);
      if (end !== -1) {
        out += source.slice(i, end);
        i = end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function extractComments(source: string): Array<{ text: string; line: number }> {
  const comments: Array<{ text: string; line: number }> = [];
  let i = 0;
  let line = 1;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const startLine = line;
      i += 2;
      const start = i;
      while (i < len && source[i] !== '\n') i++;
      comments.push({ text: source.slice(start, i), line: startLine });
      continue;
    }
    if (ch === '/' && next === '*') {
      const startLine = line;
      i += 2;
      const start = i;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      comments.push({ text: source.slice(start, i), line: startLine });
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < len) {
        const c = source[i];
        if (c === '\n') line++;
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '/' && isRegexStart(source, i)) {
      const end = findRegexEnd(source, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    i++;
  }
  return comments;
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
      name: 'direct AniList singleton import in module (use ctx.api)',
      re: /import\s*\{[^}]*\bAniList\b[^}]*\}\s*from\s*['"][^'"]*api\/anilist['"]/
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
    {
      name: 'raw window/document addEventListener in module (use ctx.listen / rc.listen)',
      re: /\b(?:window|document)\.addEventListener\s*\(/
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
      name: 'hardcoded legacy style or mount ID prefix in module (use ctx.getId / ctx.addStyle)',
      re: /\baddStyle\s*\(\s*['"`](?:ala|daiya|almal)-|\bmount\s*\(\s*\{[^}]*\bid\s*:\s*['"`](?:ala|daiya|almal)-/s
    },
    {
      name: 'raw setTimeout / setInterval in module (use ctx.timeout / ctx.interval / rc.timeout / rc.interval)',
      re: /\b(?:setTimeout|setInterval)\s*\(/,
      allow: (rel) => rel.startsWith('modules/fastLoad/') || rel === 'modules/sync/state.ts'
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
    }

    expect(violations, `Module convention violations:\n${violations.join('\n')}`).toEqual([]);
  });

  it('forbids raw console.log/debug/warn/error across core, settings, api, and modules', () => {
    const guarded = ALL_FILES.filter(
      (f) =>
        f.rel.startsWith('core/') ||
        f.rel.startsWith('settings/') ||
        f.rel.startsWith('api/') ||
        f.rel.startsWith('modules/')
    );
    const violations: string[] = [];
    const rawConsoleRe = /\bconsole\.(?:log|debug|warn|error)\s*\(/;

    for (const file of guarded) {
      const code = stripCommentsPreservingStrings(file.raw);
      if (rawConsoleRe.test(code)) {
        violations.push(`${file.rel}: raw console.{log,debug,warn,error}() call`);
      }
    }

    expect(violations, `Raw console.* violations:\n${violations.join('\n')}`).toEqual([]);
  });
});

describe('Conventions: @migration Annotation Validation', () => {
  const VALID_TAG_RE =
    /@migration\(\s*from:\s*"([^"]+)"\s*,\s*kind:\s*"(storage|import|cleanup)"\s*,\s*sunset:\s*"([^"]+)"\s*\)/g;

  it('validates every @migration(...) tag syntax and fields across src/**', () => {
    const violations: string[] = [];
    let totalTags = 0;

    for (const file of ALL_FILES) {
      const comments = extractComments(file.raw);
      for (const c of comments) {
        if (!c.text.includes('@migration')) continue;
        VALID_TAG_RE.lastIndex = 0;
        const matches = [...c.text.matchAll(VALID_TAG_RE)];
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

  it('requires every migrate() hook and migration helper in src/ to carry at least one valid @migration tag', () => {
    const violations: string[] = [];
    const migrateDeclRe =
      /\b(?:migrate\s*\([^)]*\)\s*(?::\s*[^{]+)?\{|function\s+migrate[A-Za-z0-9_]*\s*\()/g;

    for (const file of ALL_FILES) {
      if (file.rel === 'types.ts' || file.rel === 'core/registry.ts' || file.rel === 'main.ts') continue;
      const code = stripCommentsPreservingStrings(file.raw);
      migrateDeclRe.lastIndex = 0;
      if (!migrateDeclRe.test(code)) continue;

      const comments = extractComments(file.raw);
      const hasValidTag = comments.some((c) => {
        VALID_TAG_RE.lastIndex = 0;
        return VALID_TAG_RE.test(c.text);
      });
      if (!hasValidTag) {
        violations.push(`${file.rel}: defines migrate hook/helper without a valid @migration(...) annotation`);
      }
    }

    expect(violations, `Missing @migration annotations:\n${violations.join('\n')}`).toEqual([]);
  });
});