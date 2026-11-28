import { win, coreHooks, coreSession, userMap, getViewerFromWindow } from './state';

const UNFILTERED_MLC_KEYS = new Set(['type', 'userId', 'userName']);
const GQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GQL_TOKEN_RE =
  /#[^\n\r]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|\.\.\.|[{}():@$\[\]]|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*/g;

type MlcArgRef =
  | { kind: 'var'; name: string }
  | { kind: 'literal'; value: string | number };

interface GqlRootScan {
  fields: Set<string>;
  rootFieldCount: number;
  hasMutation: boolean;
  mlcArgsOk: boolean;
  mlcArgs: Map<string, MlcArgRef>;
  hasRootFragment: boolean;
  hasAliasedMlc: boolean;
}

function decodeGqlString(tok: string): string | null {
  if (tok.startsWith('"""') && tok.endsWith('"""') && tok.length >= 6) {
    return tok.slice(3, -3);
  }
  if (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) {
    try {
      const parsed = JSON.parse(tok);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return tok.slice(1, -1);
    }
  }
  return null;
}

export function stripGqlCommentsAndStrings(q: string): string {
  if (typeof q !== 'string') return '';
  return q.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n\r]*/g, ' ');
}

function scanGqlRoot(q: string): GqlRootScan {
  const fields = new Set<string>();
  const mlcArgs = new Map<string, MlcArgRef>();
  let rootFieldCount = 0;
  let hasMutation = false;
  let mlcArgsOk = true;
  let hasRootFragment = false;
  let hasAliasedMlc = false;

  if (typeof q !== 'string' || !q) {
    return { fields, rootFieldCount, hasMutation, mlcArgsOk, mlcArgs, hasRootFragment, hasAliasedMlc };
  }

  const rawTokens = q.match(GQL_TOKEN_RE);
  const tokens = rawTokens ? rawTokens.filter((t) => t[0] !== '#') : null;
  if (!tokens || tokens.length === 0) {
    return { fields, rootFieldCount, hasMutation, mlcArgsOk, mlcArgs, hasRootFragment, hasAliasedMlc };
  }

  let braceDepth = 0;
  let parenDepth = 0;
  let blockKind: 'none' | 'query' | 'other' = 'none';
  let nextHeader: 'query' | 'other' | null = null;
  let inMlcArgs = false;
  let mlcCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '{') {
      if (braceDepth === 0 && parenDepth === 0) {
        blockKind = nextHeader === 'other' ? 'other' : 'query';
        nextHeader = null;
      }
      braceDepth++;
      continue;
    }
    if (tok === '}') {
      if (braceDepth > 0) braceDepth--;
      if (braceDepth === 0) blockKind = 'none';
      continue;
    }
    if (tok === '(') {
      if (blockKind === 'query' && braceDepth === 1 && parenDepth === 0 && tokens[i - 1] === 'MediaListCollection') {
        inMlcArgs = true;
      }
      parenDepth++;
      continue;
    }
    if (tok === ')') {
      if (parenDepth > 0) parenDepth--;
      if (parenDepth === 0) inMlcArgs = false;
      continue;
    }
    if (braceDepth === 0 && parenDepth === 0) {
      if (tok === 'mutation') {
        hasMutation = true;
        nextHeader = 'other';
      } else if (tok === 'subscription' || tok === 'fragment') {
        nextHeader = 'other';
      } else if (tok === 'query') {
        nextHeader = 'query';
      }
      continue;
    }
    if (inMlcArgs && parenDepth === 1) {
      if (!GQL_IDENT_RE.test(tok) || tokens[i + 1] !== ':') {
        mlcArgsOk = false;
        continue;
      }
      if (!UNFILTERED_MLC_KEYS.has(tok) || mlcArgs.has(tok)) {
        mlcArgsOk = false;
        i += 1;
        continue;
      }
      const valIdx = i + 2;
      const valTok = tokens[valIdx];
      if (valTok === '$') {
        const varName = tokens[valIdx + 1];
        if (varName && GQL_IDENT_RE.test(varName)) {
          mlcArgs.set(tok, { kind: 'var', name: varName });
          i = valIdx + 1;
        } else {
          mlcArgsOk = false;
        }
      } else if (tok === 'type' && valTok && /^(?:ANIME|MANGA)$/.test(valTok)) {
        mlcArgs.set('type', { kind: 'literal', value: valTok });
        i = valIdx;
      } else if (tok === 'userId' && valTok && /^\d+$/.test(valTok)) {
        const num = Number(valTok);
        if (Number.isSafeInteger(num) && num > 0) {
          mlcArgs.set('userId', { kind: 'literal', value: num });
          i = valIdx;
        } else {
          mlcArgsOk = false;
        }
      } else if (tok === 'userName' && valTok && valTok[0] === '"') {
        const str = decodeGqlString(valTok);
        if (typeof str === 'string' && str.trim().length > 0) {
          mlcArgs.set('userName', { kind: 'literal', value: str });
          i = valIdx;
        } else {
          mlcArgsOk = false;
        }
      } else {
        mlcArgsOk = false;
      }
      continue;
    }
    if (blockKind === 'query' && braceDepth === 1 && parenDepth === 0) {
      if (tok === '...') {
        hasRootFragment = true;
        continue;
      }
      if (tok === '@') {
        if (fields.has('MediaListCollection')) mlcArgsOk = false;
        continue;
      }
      if (!GQL_IDENT_RE.test(tok)) continue;
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      if (prev === '...' || prev === '@' || next === ':') continue;
      if (tok === 'MediaListCollection') {
        mlcCount++;
        if (prev === ':' || mlcCount > 1) hasAliasedMlc = true;
      }
      rootFieldCount++;
      fields.add(tok);
    }
  }
  return { fields, rootFieldCount, hasMutation, mlcArgsOk, mlcArgs, hasRootFragment, hasAliasedMlc };
}

export function getTaxonomyKind(parsed: any): 'genres' | 'tags' | 'both' | null {
  const { fields } = scanGqlRoot(String(parsed?.query || ''));
  const hasGenre = fields.has('GenreCollection');
  const hasTag = fields.has('MediaTagCollection');
  if (hasGenre && hasTag && fields.size === 2) return 'both';
  if (hasGenre && !hasTag && fields.size === 1) return 'genres';
  if (!hasGenre && hasTag && fields.size === 1) return 'tags';
  return null;
}

export const isTaxonomyQuery = (parsed: any): boolean => getTaxonomyKind(parsed) !== null;

export const isMediaListQuery = (parsed: any): boolean =>
  scanGqlRoot(String(parsed?.query || '')).fields.has('MediaListCollection');

export function isUnfilteredMediaListVars(vars: any): boolean {
  if (!vars || typeof vars !== 'object') return true;
  for (const k of Object.keys(vars)) {
    if (vars[k] === undefined || vars[k] === null) continue;
    if (!UNFILTERED_MLC_KEYS.has(k)) return false;
  }
  return true;
}

export function resolveMediaListQuery(parsed: any): {
  canonical: boolean;
  vars: Record<string, any>;
  hasInlineLiterals: boolean;
} {
  const scan = scanGqlRoot(String(parsed?.query || ''));
  const rawVars =
    parsed?.variables && typeof parsed.variables === 'object' && !Array.isArray(parsed.variables)
      ? parsed.variables
      : {};

  let hasInlineLiterals = false;
  for (const ref of scan.mlcArgs.values()) {
    if (ref.kind === 'literal') {
      hasInlineLiterals = true;
      break;
    }
  }

  let canonical =
    scan.fields.size === 1 &&
    scan.fields.has('MediaListCollection') &&
    scan.rootFieldCount === 1 &&
    !scan.hasMutation &&
    !scan.hasRootFragment &&
    !scan.hasAliasedMlc &&
    scan.mlcArgsOk;

  if (!canonical) {
    return { canonical: false, vars: normalizeVariables(rawVars), hasInlineLiterals };
  }

  const boundVarNames = new Set<string>();
  for (const ref of scan.mlcArgs.values()) {
    if (ref.kind === 'var') boundVarNames.add(ref.name);
  }
  for (const k of Object.keys(rawVars)) {
    if (rawVars[k] === undefined || rawVars[k] === null) continue;
    if (!boundVarNames.has(k) && !UNFILTERED_MLC_KEYS.has(k)) {
      canonical = false;
      break;
    }
  }

  const effectiveVars: Record<string, any> = {};

  if (canonical) {
    const typeArg = scan.mlcArgs.get('type');
    if (typeArg?.kind === 'literal') {
      const lit = String(typeArg.value).toUpperCase();
      if (rawVars.type !== undefined && rawVars.type !== null && String(rawVars.type).toUpperCase() !== lit) {
        canonical = false;
      } else {
        effectiveVars.type = lit;
      }
    } else if (typeArg?.kind === 'var') {
      const v = rawVars[typeArg.name];
      if (v !== undefined && v !== null) {
        if (typeof v !== 'string' || !/^(?:ANIME|MANGA)$/i.test(v.trim())) {
          canonical = false;
        } else {
          const norm = v.trim().toUpperCase();
          if (
            typeArg.name !== 'type' &&
            rawVars.type !== undefined &&
            rawVars.type !== null &&
            String(rawVars.type).toUpperCase() !== norm
          ) {
            canonical = false;
          } else {
            effectiveVars.type = norm;
          }
        }
      }
    } else if (rawVars.type !== undefined && rawVars.type !== null && String(rawVars.type).toUpperCase() !== 'ANIME') {
      canonical = false;
    }
  }

  if (canonical) {
    const idArg = scan.mlcArgs.get('userId');
    if (idArg?.kind === 'literal') {
      const lit = Number(idArg.value);
      if (rawVars.userId !== undefined && rawVars.userId !== null && Number(rawVars.userId) !== lit) {
        canonical = false;
      } else {
        effectiveVars.userId = lit;
      }
    } else if (idArg?.kind === 'var') {
      const v = rawVars[idArg.name];
      if (v !== undefined && v !== null) {
        const num =
          typeof v === 'number'
            ? v
            : typeof v === 'string' && /^\d+$/.test(v.trim())
            ? Number(v.trim())
            : Number.NaN;
        if (!Number.isSafeInteger(num) || num <= 0) {
          canonical = false;
        } else if (
          idArg.name !== 'userId' &&
          rawVars.userId !== undefined &&
          rawVars.userId !== null &&
          Number(rawVars.userId) !== num
        ) {
          canonical = false;
        } else {
          effectiveVars.userId = num;
        }
      }
    } else if (rawVars.userId !== undefined && rawVars.userId !== null) {
      canonical = false;
    }
  }

  if (canonical) {
    const nameArg = scan.mlcArgs.get('userName');
    if (nameArg?.kind === 'literal') {
      const lit = String(nameArg.value).trim();
      if (
        rawVars.userName !== undefined &&
        rawVars.userName !== null &&
        String(rawVars.userName).trim().toLowerCase() !== lit.toLowerCase()
      ) {
        canonical = false;
      } else {
        effectiveVars.userName = lit;
      }
    } else if (nameArg?.kind === 'var') {
      const v = rawVars[nameArg.name];
      if (v !== undefined && v !== null) {
        if (typeof v !== 'string' || !v.trim()) {
          canonical = false;
        } else if (
          nameArg.name !== 'userName' &&
          rawVars.userName !== undefined &&
          rawVars.userName !== null &&
          String(rawVars.userName).trim().toLowerCase() !== v.trim().toLowerCase()
        ) {
          canonical = false;
        } else {
          effectiveVars.userName = v.trim();
        }
      }
    } else if (rawVars.userName !== undefined && rawVars.userName !== null) {
      canonical = false;
    }
  }

  if (canonical && effectiveVars.userId && effectiveVars.userName) {
    const mappedId = userMap.get(String(effectiveVars.userName).toLowerCase());
    if (mappedId && mappedId !== effectiveVars.userId) {
      canonical = false;
    } else if (
      scan.mlcArgs.get('userId')?.kind === 'literal' &&
      scan.mlcArgs.get('userName')?.kind === 'literal' &&
      mappedId !== effectiveVars.userId
    ) {
      canonical = false;
    }
  }

  return {
    canonical,
    vars: normalizeVariables(canonical ? effectiveVars : rawVars),
    hasInlineLiterals
  };
}

export function isUnfilteredMediaListQuery(parsed: any): boolean {
  return resolveMediaListQuery(parsed).canonical;
}

export const isViewerQuery = (parsed: any): boolean =>
  scanGqlRoot(String(parsed?.query || '')).fields.has('Viewer');

export const isUserQuery = (parsed: any): boolean =>
  scanGqlRoot(String(parsed?.query || '')).fields.has('User') && !isVolatile(parsed);

export const isMutation = (parsed: any): boolean =>
  scanGqlRoot(String(parsed?.query || '')).hasMutation;

export const isVolatile = (parsed: any): boolean =>
  /\b(?:notifications|activities|Activity|Notification)\s*\(/.test(
    stripGqlCommentsAndStrings(String(parsed?.query || ''))
  );

export const noStore = (d: any) =>
  d.cache === 'no-store' || d.cache === 'reload' || !!d.headers.get('cache-control')?.toLowerCase().includes('no-store');

export function normalizeGqlQuery(q: string): string {
  if (typeof q !== 'string') return '';
  return q
    .replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n\r]*/g, (m) => (m[0] === '#' ? '' : m))
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}():,])\s*/g, '$1')
    .trim();
}

export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + (i & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export function hashGqlQuery(q: string): string {
  return hashString(normalizeGqlQuery(q));
}

export function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function normalizeVariables(vars: any): any {
  if (!vars || typeof vars !== 'object') return {};
  const copy: Record<string, any> = {};
  for (const k of Object.keys(vars)) {
    if (vars[k] !== undefined && vars[k] !== null) {
      copy[k] = vars[k];
    }
  }
  if (copy.userName && !copy.userId) {
    const name = String(copy.userName).toLowerCase();
    const snap = coreSession?.peek();
    const mine = String(snap?.username || '').toLowerCase();
    const id = userMap.get(name) || (name === mine && snap?.userId ? Number(snap.userId) : 0);
    if (id) {
      copy.userId = id;
      delete copy.userName;
    }
  }
  if (copy.userId && copy.userName) {
    delete copy.userName;
  }
  return copy;
}

export function parseBody(body: string) {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.query === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function buildQueryCacheKey(
  prefix: string,
  endpoint: string,
  query: any,
  variables: any,
  authHeader?: string
): string {
  const queryStr = typeof query === 'string' ? query : String(query || '');
  const q = { query: queryStr, variables };
  if (isMediaListQuery(q)) {
    const { canonical, vars } = resolveMediaListQuery(q);
    const { type = 'ANIME', userId, userName, ...rest } = vars;
    let resolvedId = userId;
    if (!resolvedId && userName) {
      resolvedId = userMap.get(String(userName).toLowerCase());
    }
    const who = resolvedId || (userName ? String(userName).toLowerCase() : getViewerFromWindow().id || 'me');
    const suffix = canonical
      ? stableStringify(rest)
      : `${stableStringify(rest)}:${hashGqlQuery(queryStr)}`;
    return `${prefix}:MediaListCollection:${String(type).toUpperCase()}:${who}:${suffix}`;
  }
  const taxKind = getTaxonomyKind(q);
  if (taxKind) {
    const normVars = stableStringify(normalizeVariables(variables));
    return `${prefix}:Taxonomy:${taxKind}:${hashGqlQuery(queryStr)}:${normVars}`;
  }
  const auth = String(authHeader || '');
  if (isViewerQuery(q)) {
    const authId = auth ? hashString(auth) : 'anon';
    const normVars = stableStringify(normalizeVariables(variables));
    return `${prefix}:Viewer:${authId}:${hashGqlQuery(queryStr)}:${normVars}`;
  }
  const normQuery = normalizeGqlQuery(queryStr);
  const normVars = stableStringify(normalizeVariables(variables));
  return `${String(endpoint ?? '')}\u0001${auth ? hashString(auth) : ''}\u0001${normQuery}\u0001${normVars}`;
}

export function isRpcBlocked(query: any, variables: any): boolean {
  const queryStr = typeof query === 'string' ? query : query == null ? '' : String(query);
  if (coreHooks?.isRpcBlocked(queryStr, variables)) return true;
  const blocker = (win as any).__ALFL_RPC_BLOCK__;
  if (typeof blocker === 'function') {
    try {
      return Boolean(blocker(queryStr, variables));
    } catch {
      return false;
    }
  }
  return false;
}