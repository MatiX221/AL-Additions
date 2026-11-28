import { unsafeWindow } from 'vite-plugin-monkey/dist/client';
import { CoreHooks } from '../core/bus';
import {
  ANILIST_SESSION_KEYS,
  type AniListClient,
  type AniListSession,
  type MediaEntry,
  type MediaListCollectionData,
  type MediaListEntryItem,
  type MediaListGroup,
  type MediaListResult,
  type QueryOptions,
  type ViewerInfo
} from '../types';
import {
  authError,
  createAbortError,
  createCoreLogger,
  isAbortError,
  isGqlMutation,
  raceWithSignal,
  sleep,
  store
} from '../utils/helpers';
import { createSharedFlight, type SharedFlight } from '../utils/flight';
import { RateLimiter } from '../utils/limiter';

const anilistLog = createCoreLogger('anilist');

const NAV_SELECTORS = {
  loginNav: 'nav a[href="/login"], .nav a[href="/login"]',
  userNav: 'nav a[href^="/user/"], .nav-wrap a[href^="/user/"], .nav a[href^="/user/"]',
  loggedInNav: 'nav a[href^="/user/"], .nav-wrap a[href^="/user/"], .user-wrap .avatar'
} as const;

function isLoggedOutNav(doc: Document = document): boolean {
  return !!doc?.querySelector?.(NAV_SELECTORS.loginNav);
}

function hasLoggedInNav(doc: Document = document): boolean {
  return !!doc?.querySelector?.(NAV_SELECTORS.loggedInNav);
}

function navUserName(doc: Document = document): string {
  const href = doc?.querySelector?.(NAV_SELECTORS.userNav)?.getAttribute('href');
  const m = href && href.match(/^\/user\/([^/?#]+)/);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export type {
  AniListClient,
  AniListSession,
  ViewerInfo,
  MediaEntry,
  MediaListEntryItem,
  MediaListGroup,
  MediaListCollectionData,
  MediaListResult,
  QueryOptions
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal);
}

interface EntityMeta {
  entityKey: string;
  isSuperset: boolean;
  requiredFields: Set<string>;
}

function stripCommentsAndStrings(q: string): string {
  let out = '';
  let i = 0;
  const len = q.length;
  while (i < len) {
    const ch = q[i];
    if (ch === '#') {
      while (i < len && q[i] !== '\n' && q[i] !== '\r') i++;
      out += ' ';
      continue;
    }
    if (ch === '"') {
      if (q[i + 1] === '"' && q[i + 2] === '"') {
        i += 3;
        while (i < len) {
          if (q[i] === '\\' && q[i + 1] === '"' && q[i + 2] === '"' && q[i + 3] === '"') {
            i += 4;
            continue;
          }
          if (q[i] === '"' && q[i + 1] === '"' && q[i + 2] === '"') {
            i += 3;
            break;
          }
          i++;
        }
      } else {
        i++;
        while (i < len) {
          if (q[i] === '\\') {
            i += 2;
            continue;
          }
          if (q[i] === '"') {
            i++;
            break;
          }
          i++;
        }
      }
      out += ' "" ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function parseRootSelection(q: string): { rootField: string; rootArgs: string; innerSelection: string } | null {
  const stripped = stripCommentsAndStrings(q);
  const firstBrace = stripped.indexOf('{');
  if (firstBrace === -1) return null;

  const header = stripped.slice(0, firstBrace).trim();
  if (/\b(?:mutation|subscription|fragment)\b/i.test(header) || /@/.test(header)) return null;

  let braceDepth = 0;
  let rootCount = 0;
  let rootField = '';
  let rootArgs = '';
  const innerChars: string[] = [];
  let inRootFieldBody = false;

  const len = stripped.length;
  let i = firstBrace;
  while (i < len) {
    const ch = stripped[i];

    if (ch === '{') {
      braceDepth++;
      if (braceDepth === 2 && rootCount === 1 && !inRootFieldBody) {
        inRootFieldBody = true;
      } else if (inRootFieldBody) {
        innerChars.push(ch);
      }
      i++;
      continue;
    }

    if (ch === '}') {
      if (braceDepth === 2 && inRootFieldBody) {
        inRootFieldBody = false;
      } else if (inRootFieldBody) {
        innerChars.push(ch);
      }
      braceDepth--;
      i++;
      if (braceDepth === 0) {
        if (stripped.slice(i).trim()) return null;
        break;
      }
      continue;
    }

    if (inRootFieldBody) {
      innerChars.push(ch);
      i++;
      continue;
    }

    if (braceDepth === 1) {
      if (/\s|,/.test(ch)) {
        i++;
        continue;
      }
      if (ch === '.' && stripped.slice(i, i + 3) === '...') {
        return null;
      }
      if (/[a-zA-Z_]/.test(ch)) {
        let end = i + 1;
        while (end < len && /[a-zA-Z0-9_]/.test(stripped[end])) end++;
        const ident = stripped.slice(i, end);
        let j = end;
        while (j < len && /\s/.test(stripped[j])) j++;

        if (stripped[j] === ':') {
          return null;
        }

        rootCount++;
        if (rootCount > 1) return null;
        rootField = ident;

        if (stripped[j] === '(') {
          let pd = 1;
          let k = j + 1;
          while (k < len && pd > 0) {
            if (stripped[k] === '(') pd++;
            else if (stripped[k] === ')') pd--;
            k++;
          }
          if (pd !== 0) return null;
          rootArgs = stripped.slice(j + 1, k - 1).trim();
          i = k;
          continue;
        }
        i = end;
        continue;
      }
      return null;
    }

    i++;
  }

  if (braceDepth !== 0 || rootCount !== 1 || !rootField) return null;
  const innerSelection = innerChars.join('');
  return { rootField, rootArgs, innerSelection };
}

function parseTopLevelArgs(args: string): Record<string, string> | null {
  if (!args) return {};
  const result: Record<string, string> = {};
  let i = 0;
  const len = args.length;
  while (i < len) {
    while (i < len && /[\s,]/.test(args[i])) i++;
    if (i >= len) break;
    if (!/[a-zA-Z_]/.test(args[i])) return null;
    let nameEnd = i + 1;
    while (nameEnd < len && /[a-zA-Z0-9_]/.test(args[nameEnd])) nameEnd++;
    const key = args.slice(i, nameEnd);
    let j = nameEnd;
    while (j < len && /\s/.test(args[j])) j++;
    if (args[j] !== ':') return null;
    j++;
    while (j < len && /\s/.test(args[j])) j++;
    if (j >= len) return null;

    let valEnd = j;
    let depth = 0;
    while (valEnd < len) {
      const c = args[valEnd];
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') {
        if (depth === 0) return null;
        depth--;
        if (depth === 0) {
          valEnd++;
          break;
        }
      } else if (depth === 0 && /[\s,]/.test(c)) {
        break;
      }
      valEnd++;
    }
    if (depth !== 0) return null;
    result[key] = args.slice(j, valEnd).trim();
    i = valEnd;
  }
  return result;
}

const UNRESOLVABLE_ARG = Symbol('unresolvable');

function parsePositiveId(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function extractSelectionPaths(inner: string): Set<string> | null {
  const paths = new Set<string>();
  const stack: string[] = [];
  const blockHasField: boolean[] = [];
  let lastIdent = '';
  const tokenRe = /[{}]|[a-zA-Z_][a-zA-Z0-9_]*/g;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(inner)) !== null) {
    const tok = m[0];
    if (tok === '{') {
      if (!lastIdent) return null;
      stack.push(lastIdent);
      blockHasField.push(false);
      lastIdent = '';
    } else if (tok === '}') {
      if (stack.length === 0 || !blockHasField.pop()) return null;
      stack.pop();
      lastIdent = '';
    } else {
      if (blockHasField.length > 0) blockHasField[blockHasField.length - 1] = true;
      paths.add(stack.length > 0 ? `${stack.join('.')}.${tok}` : tok);
      lastIdent = tok;
    }
  }

  return stack.length === 0 && paths.size > 0 ? paths : null;
}

function parseEntityMeta(query: string, vars: Record<string, any>): EntityMeta | null {
  if (typeof query !== 'string') return null;
  const parsed = parseRootSelection(query);
  if (!parsed) return null;
  if (/[:.@()]/.test(parsed.innerSelection)) return null;

  const requiredFields = extractSelectionPaths(parsed.innerSelection);
  if (!requiredFields) return null;

  const argMap = parseTopLevelArgs(parsed.rootArgs);
  if (!argMap) return null;
  const safeVars = vars && typeof vars === 'object' ? vars : {};

  if (parsed.rootField === 'MediaListCollection') {
    const allowedArgs = new Set(['userId', 'userName', 'type']);
    for (const k of Object.keys(argMap)) {
      if (!allowedArgs.has(k)) return null;
    }
    const boundVars = new Set<string>();
    const resolveArg = (argName: string): any => {
      const raw = argMap[argName];
      if (!raw) return undefined;
      if (raw.startsWith('$')) {
        const varName = raw.slice(1);
        boundVars.add(varName);
        return safeVars[varName];
      }
      if (argName === 'userId' && /^\d+$/.test(raw)) return Number(raw);
      if (argName === 'type' && /^(?:ANIME|MANGA)$/i.test(raw)) return raw.toUpperCase();
      return UNRESOLVABLE_ARG;
    };

    const rawType = resolveArg('type');
    const rawUserId = resolveArg('userId');
    const rawUserName = resolveArg('userName');
    if (
      rawType === UNRESOLVABLE_ARG ||
      rawUserId === UNRESOLVABLE_ARG ||
      rawUserName === UNRESOLVABLE_ARG
    ) {
      return null;
    }

    for (const k of Object.keys(safeVars)) {
      if (!boundVars.has(k) && safeVars[k] !== undefined && safeVars[k] !== null) {
        return null;
      }
    }

    if (typeof rawType !== 'string') return null;
    const type = rawType.trim().toUpperCase();
    if (type !== 'ANIME' && type !== 'MANGA') return null;
    if (rawUserId != null && (typeof rawUserId !== 'number' || !Number.isSafeInteger(rawUserId) || rawUserId <= 0)) {
      return null;
    }
    if (rawUserName != null && (typeof rawUserName !== 'string' || !rawUserName.trim())) {
      return null;
    }
    const normName = rawUserName ? rawUserName.trim().toLowerCase() : '';
    const who = rawUserId || normName || 'me';

    return {
      entityKey: `MediaListCollection:${type}:${who}`,
      isSuperset: requiredFields.size > 12,
      requiredFields
    };
  }

  if (parsed.rootField === 'Media') {
    const allowedArgs = new Set(['id', 'type']);
    for (const k of Object.keys(argMap)) {
      if (!allowedArgs.has(k)) return null;
    }
    const boundVars = new Set<string>();
    let mediaId: any;
    if (argMap.id) {
      if (argMap.id.startsWith('$')) {
        const varName = argMap.id.slice(1);
        boundVars.add(varName);
        mediaId = safeVars[varName];
      } else if (/^\d+$/.test(argMap.id)) {
        mediaId = Number(argMap.id);
      }
    }
    if (typeof mediaId !== 'number' || !Number.isSafeInteger(mediaId) || mediaId <= 0) return null;

    let resolvedType = '';
    if (argMap.type !== undefined) {
      let rawType: any;
      if (argMap.type.startsWith('$')) {
        const varName = argMap.type.slice(1);
        boundVars.add(varName);
        rawType = safeVars[varName];
      } else if (/^(?:ANIME|MANGA)$/i.test(argMap.type)) {
        rawType = argMap.type.toUpperCase();
      } else {
        return null;
      }
      if (rawType !== undefined && rawType !== null) {
        if (typeof rawType !== 'string') return null;
        const norm = rawType.trim().toUpperCase();
        if (norm !== 'ANIME' && norm !== 'MANGA') return null;
        resolvedType = norm;
      }
    }

    for (const k of Object.keys(safeVars)) {
      if (!boundVars.has(k) && safeVars[k] !== undefined && safeVars[k] !== null) {
        return null;
      }
    }

    return {
      entityKey: `Media:${mediaId}:${resolvedType || '*'}`,
      isSuperset: requiredFields.size > 10,
      requiredFields
    };
  }

  if (parsed.rootField === 'Viewer') {
    if (Object.keys(argMap).length > 0) return null;
    for (const k of Object.keys(safeVars)) {
      if (safeVars[k] !== undefined && safeVars[k] !== null) return null;
    }
    return {
      entityKey: 'Viewer',
      isSuperset: requiredFields.has('mediaListOptions.scoreFormat'),
      requiredFields
    };
  }

  return null;
}

function isSubsetOf(subset: Set<string>, superset: Set<string>): boolean {
  for (const item of subset) {
    if (!superset.has(item)) return false;
  }
  return true;
}

const MEDIA_LIST_SINGLE_QUERY = `query ($userId: Int, $userName: String, $type: MediaType) {
      MediaListCollection(userId: $userId, userName: $userName, type: $type) {
        user { id name }
        lists {
          name
          isCustomList
          status
          entries {
            id
            mediaId
            status
            score
            progress
            progressVolumes
            repeat
            priority
            notes
            customLists
            startedAt { year month day }
            completedAt { year month day }
            media {
              id
              idMal
              format
              episodes
              chapters
              status
              title { userPreferred english romaji native }
            }
          }
        }
      }
    }`;

const MEDIA_LIST_REQUIRED_FIELDS: Set<string> =
  extractSelectionPaths(parseRootSelection(MEDIA_LIST_SINGLE_QUERY)?.innerSelection ?? '') ?? new Set();

export const AniList = (() => {
  const limiter = new RateLimiter({ rate: 25, max: 90, burst: 1, persistKey: 'ala_anilist_api_resume_at' });

  interface CachedRecord {
    time: number;
    data: any;
    isSuperset: boolean;
    fields: Set<string>;
  }

  interface InflightEntity {
    flight: SharedFlight<any>;
    isSuperset: boolean;
    fields: Set<string>;
  }

  interface InflightExact {
    flight: SharedFlight<any>;
    entityKey?: string;
  }

  const entityCache = new Map<string, CachedRecord>();
  const inflightExact = new Map<string, InflightExact>();
  const inflightEntities = new Map<string, InflightEntity>();
  const ENTITY_TTL = 3 * 60_000;
  let cacheEpoch = 0;
  let viewerEpoch = 0;
  let unsubGql: (() => void) | null = null;

  const pageWin = (): any => (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

  function safeBridge<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      anilistLog.debug('Cache bridge error:', e);
      return undefined;
    }
  }

  function maybeUnsubscribeMutationListener(): void {
    if (
      unsubGql &&
      entityCache.size === 0 &&
      inflightExact.size === 0 &&
      inflightEntities.size === 0
    ) {
      const unsub = unsubGql;
      unsubGql = null;
      try {
        unsub();
      } catch (_) {}
    }
  }

  function invalidateLocal(entityKeyPrefix?: string): void {
    cacheEpoch++;
    if (!entityKeyPrefix) {
      entityCache.clear();
      inflightEntities.clear();
      inflightExact.clear();
    } else {
      const normPrefix = entityKeyPrefix.replace(/:+$/, '');
      if (normPrefix) {
        const matchesPrefix = (k?: string): boolean =>
          !!k && (k === normPrefix || k.startsWith(`${normPrefix}:`));
        for (const k of entityCache.keys()) {
          if (matchesPrefix(k)) entityCache.delete(k);
        }
        for (const k of inflightEntities.keys()) {
          if (matchesPrefix(k)) inflightEntities.delete(k);
        }
        for (const [k, entry] of inflightExact.entries()) {
          if (matchesPrefix(entry.entityKey)) {
            inflightExact.delete(k);
          }
        }
      }
    }
    maybeUnsubscribeMutationListener();
  }

  function ensureMutationListener(): void {
    if (unsubGql) return;
    try {
      unsubGql = CoreHooks.onGqlFetch((event) => {
        const rawQuery = typeof event?.query === 'string' ? event.query : '';
        if (rawQuery && isGqlMutation(rawQuery)) {
          invalidateLocal();
        }
      });
    } catch (_) {
      unsubGql = null;
    }
  }

  function getCsrfToken(): string | null {
    const win = pageWin();
    if (typeof win.al_token === 'string' && win.al_token) return win.al_token;
    try {
      const meta = win.document?.querySelector('meta[name="csrf-token"]');
      if (meta?.content) return meta.content;
    } catch (_) {}
    try {
      const scripts = win.document?.querySelectorAll('head script') || [];
      for (const s of scripts) {
        const m = s.textContent?.match(/window\.al_token\s*=\s*['"]([^'"]+)['"]/);
        if (m && m[1]) return m[1];
      }
    } catch (_) {}
    return null;
  }

  const clearViewer = (): void => {
    viewerEpoch++;
    CoreHooks.setSessionClearing(true);
    try {
      for (const k of ANILIST_SESSION_KEYS) {
        store.del(k);
      }
      invalidate();
      CoreHooks.clearAuth();
    } finally {
      CoreHooks.setSessionClearing(false);
    }
  };

  function readPageDoc(): { win: any; doc: Document | undefined } {
    const win = pageWin();
    const doc = (win?.document || (typeof document !== 'undefined' ? document : undefined)) as Document | undefined;
    return { win, doc };
  }

  function peek(opts?: { reconcile?: boolean }): import('../types').AniListSessionSnapshot {
    if (opts?.reconcile) syncFromPage();
    const { win, doc } = readPageDoc();
    if (doc && isLoggedOutNav(doc)) {
      return { userId: null, username: null, scoreFormat: null };
    }

    const storedId = parsePositiveId(store.get('al_user_id', null));
    const storedNameRaw = store.get<string | null>('al_username', null);
    const storedName = typeof storedNameRaw === 'string' && storedNameRaw ? storedNameRaw : null;
    const storedFmtRaw = store.get<string | null>('al_score_format', null);
    const storedFmt = typeof storedFmtRaw === 'string' && storedFmtRaw ? storedFmtRaw : null;

    const cachedViewer = entityCache.get('Viewer')?.data?.Viewer as
      | { id?: number; name?: string; mediaListOptions?: { scoreFormat?: string } }
      | undefined;
    const cachedViewerId = parsePositiveId(cachedViewer?.id);
    const nuxtUser = win?.__NUXT__?.state?.auth?.user || win?.__NUXT__?.state?.user;
    const nuxtId = parsePositiveId(nuxtUser?.id);
    const navName = doc ? navUserName(doc) || null : null;

    if (nuxtId !== null) {
      const storedMismatch =
        (storedId !== null && storedId !== nuxtId) ||
        (storedId === null &&
          storedName !== null &&
          typeof nuxtUser.name === 'string' &&
          storedName.toLowerCase() !== nuxtUser.name.toLowerCase());
      const cachedMatches = cachedViewerId !== null && cachedViewerId === nuxtId;
      const username =
        (nuxtUser.name ? String(nuxtUser.name) : null) ||
        (cachedMatches && cachedViewer?.name ? String(cachedViewer.name) : null) ||
        (!storedMismatch ? storedName : null) ||
        navName ||
        null;
      const scoreFormat =
        (cachedMatches ? cachedViewer?.mediaListOptions?.scoreFormat || null : null) ||
        (!storedMismatch ? storedFmt : null);
      return { userId: nuxtId, username, scoreFormat };
    }

    if (navName) {
      const storedMatches = storedName === null || storedName.toLowerCase() === navName.toLowerCase();
      const cachedMatches = !!(cachedViewer?.name && String(cachedViewer.name).toLowerCase() === navName.toLowerCase());
      return {
        userId:
          (storedMatches ? storedId : null) ||
          (cachedMatches ? cachedViewerId : null),
        username: (storedMatches && storedName) || navName,
        scoreFormat:
          (storedMatches ? storedFmt : null) ||
          (cachedMatches ? cachedViewer?.mediaListOptions?.scoreFormat || null : null)
      };
    }

    return {
      userId: storedId || cachedViewerId,
      username: storedName || (cachedViewer?.name ? String(cachedViewer.name) : null),
      scoreFormat: storedFmt || cachedViewer?.mediaListOptions?.scoreFormat || null
    };
  }

  function syncFromPage(): void {
    const { win, doc } = readPageDoc();

    if (doc && isLoggedOutNav(doc)) {
      const hasStoredSession = ANILIST_SESSION_KEYS.some((k) => store.get(k, undefined) !== undefined);
      if (hasStoredSession || entityCache.has('Viewer')) {
        clearViewer();
      }
      return;
    }
    const nuxtUser = win?.__NUXT__?.state?.auth?.user || win?.__NUXT__?.state?.user;
    const nuxtId = parsePositiveId(nuxtUser?.id);
    if (nuxtId !== null) {
      const storedId = parsePositiveId(store.get('al_user_id', null));
      const cachedViewerId = parsePositiveId(entityCache.get('Viewer')?.data?.Viewer?.id);
      if ((storedId !== null && storedId !== nuxtId) || (cachedViewerId !== null && cachedViewerId !== nuxtId)) {
        clearViewer();
      }
      return;
    }

    const pageName =
      (typeof nuxtUser?.name === 'string' && nuxtUser.name.trim()) || (doc ? navUserName(doc) : '');
    if (pageName) {
      const storedName = store.get<string | null>('al_username', null);
      const cachedViewerName = entityCache.get('Viewer')?.data?.Viewer?.name;
      if (
        (storedName && storedName.toLowerCase() !== pageName.toLowerCase()) ||
        (typeof cachedViewerName === 'string' &&
          cachedViewerName &&
          cachedViewerName.toLowerCase() !== pageName.toLowerCase())
      ) {
        clearViewer();
      }
    }
  }

  function isViewerMismatchedWithPage(v?: { id?: number | null; name?: string | null } | null): boolean {
    const { win, doc } = readPageDoc();
    if (doc && isLoggedOutNav(doc)) return true;

    const nuxtUser = win?.__NUXT__?.state?.auth?.user || win?.__NUXT__?.state?.user;
    const nuxtId = parsePositiveId(nuxtUser?.id);
    const vId = parsePositiveId(v?.id);
    if (nuxtId !== null && vId !== null) {
      if (vId !== nuxtId) return true;
    }

    const pageName =
      (nuxtUser?.name ? String(nuxtUser.name).trim() : '') || (doc ? navUserName(doc) : '');
    if (pageName && v?.name) {
      if (String(v.name).trim().toLowerCase() !== pageName.toLowerCase()) return true;
    }

    return false;
  }

  function recordHint(hint: import('../types').AniListViewerHint): void {
    if (!hint || CoreHooks.isSessionClearing()) return;
    const nextId =
      typeof hint.userId === 'number' && Number.isFinite(hint.userId) && hint.userId > 0
        ? Math.floor(hint.userId)
        : null;
    const nextName = typeof hint.username === 'string' && hint.username.trim() ? hint.username.trim() : null;
    if (nextId === null && nextName === null) return;
    syncFromPage();
    if (CoreHooks.isSessionClearing()) return;
    if (isViewerMismatchedWithPage({ id: nextId, name: nextName })) return;
    if (nextId !== null) {
      const storedId = Number(store.get('al_user_id', 0));
      if (storedId && storedId !== nextId) {
        store.del('al_username');
        store.del('al_score_format');
      }
      if (storedId !== nextId) {
        store.set('al_user_id', nextId);
      }
    }
    if (nextName !== null && store.get<string | null>('al_username', null) !== nextName) {
      store.set('al_username', nextName);
    }
  }

  function isBrowserLoggedIn(opts?: { reconcile?: boolean }): boolean {
    if (opts?.reconcile !== false) syncFromPage();
    const { win, doc } = readPageDoc();
    if (doc && isLoggedOutNav(doc)) return false;
    const nuxtUser = win?.__NUXT__?.state?.auth?.user || win?.__NUXT__?.state?.user;
    if (parsePositiveId(nuxtUser?.id) !== null) return true;
    if (doc && hasLoggedInNav(doc)) return true;
    return Boolean(parsePositiveId(store.get('al_user_id', null)) !== null && store.get('al_username', null));
  }

  const header = (res: Response | undefined, name: string): string | null => {
    try {
      return res?.headers?.get?.(name) ?? null;
    } catch (_) {
      return null;
    }
  };

  function resetDelay(res: Response | undefined): number {
    const retry = Number(header(res, 'Retry-After'));
    if (Number.isFinite(retry) && retry > 0) return Math.max(0, Math.min(retry * 1000, 120000));
    const reset = Number(header(res, 'X-RateLimit-Reset'));
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(0, Math.min((reset > 1e12 ? reset : reset * 1000) - Date.now(), 120000));
    }
    return 0;
  }

  function handle(res: Response | undefined): void {
    const advertised = Number(header(res, 'X-RateLimit-Limit'));
    if (advertised > 0) limiter.setRate(Math.floor(advertised * 0.85));
    if (res?.status === 429) return limiter.limit(resetDelay(res) || 60000);
    const remaining = header(res, 'X-RateLimit-Remaining');
    if (remaining != null && Number(remaining) <= 1) limiter.limit(resetDelay(res));
  }

  async function executeNetworkRequest<T>(
    q: string,
    variables: Record<string, any>,
    retries: number,
    forceFresh = false,
    attempt = 0,
    signal?: AbortSignal
  ): Promise<T> {
    throwIfAborted(signal);
    const safeRetries = Number.isFinite(retries) ? Math.max(0, Math.floor(retries)) : 3;
    const csrfToken = getCsrfToken();
    const win = pageWin();
    const fetchFn = (typeof win.fetch === 'function' ? win.fetch : fetch).bind(win);
    const backoff = () => sleep(Math.min(30000, 1500 * (attempt + 1)), signal);

    const endpoint = `${win.location?.origin || 'https://anilist.co'}/graphql`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(forceFresh ? { 'Cache-Control': 'no-cache' } : {})
    };

    if (csrfToken) {
      headers['X-CSRF-TOKEN'] = csrfToken;
    }

    let res: Response;

    try {
      await limiter.acquire({ signal });
      throwIfAborted(signal);
      res = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        cache: forceFresh ? 'no-store' : undefined,
        credentials: 'include',
        body: JSON.stringify({ query: q, variables }),
        signal,
        __alfl: 'internal'
      } as RequestInit);
    } catch (e: any) {
      if (signal?.aborted || isAbortError(e)) {
        throw signal?.aborted ? createAbortError(signal) : e;
      }
      if (safeRetries > 0) {
        await backoff();
        return executeNetworkRequest<T>(q, variables, safeRetries - 1, forceFresh, attempt + 1, signal);
      }
      throw new Error(`AniList network error: ${e?.message || e}`);
    }

    throwIfAborted(signal);
    handle(res);

    if (!res) {
      throw new Error('AniList network error: empty response');
    }

    if ((res.status === 429 || res.status >= 500) && safeRetries > 0) {
      if (res.status >= 500) await backoff();
      throwIfAborted(signal);
      return executeNetworkRequest<T>(q, variables, safeRetries - 1, forceFresh, attempt + 1, signal);
    }

    let json: any = null;
    try {
      json = await res.json();
    } catch (e: any) {
      if (signal?.aborted || isAbortError(e)) {
        throw signal?.aborted ? createAbortError(signal) : e;
      }
    }
    throwIfAborted(signal);

    const message = json?.errors?.length ? json.errors.map((e: any) => e.message).join('; ') : '';
    if (res.status === 401 || /invalid token|unauthenticated|unauthorized/i.test(message)) {
      clearViewer();
      throw authError('AniList', 'AniList session unauthenticated — please log in to AniList.');
    }
    if (message) throw new Error(message);
    if (!res.ok || !json) throw new Error(`AniList API HTTP ${res.status}`);
    return json.data as T;
  }

  async function query<T = any>(
    q: string,
    variables: Record<string, any> = {},
    optionsOrRetries?: number | QueryOptions
  ): Promise<T> {
    const opts: QueryOptions =
      typeof optionsOrRetries === 'number'
        ? { retries: optionsOrRetries }
        : optionsOrRetries || {};
    throwIfAborted(opts.signal);
    const rawRetries = opts.retries ?? 3;
    const retries = Number.isFinite(rawRetries) ? Math.max(0, Math.floor(rawRetries)) : 3;
    const isMutation = isGqlMutation(q);

    if (isMutation) {
      invalidate();
      return executeNetworkRequest<T>(q, variables, retries, false, 0, opts.signal).finally(() => {
        invalidate();
      });
    }

    ensureMutationListener();

    const meta = parseEntityMeta(q, variables);
    const now = Date.now();
    const exactKey = `${q}\u0001${JSON.stringify(variables)}`;

    if (!opts.forceFresh && meta) {
      const cached = entityCache.get(meta.entityKey);
      if (cached && now - cached.time < ENTITY_TTL && isSubsetOf(meta.requiredFields, cached.fields)) {
        anilistLog.debug('🎯 Cache HIT via Subset matching:', meta.entityKey);
        return cached.data as T;
      }
    }

    if (meta && !opts.forceFresh) {
      const flyingEntity = inflightEntities.get(meta.entityKey);
      if (
        flyingEntity &&
        !flyingEntity.flight.controller.signal.aborted &&
        isSubsetOf(meta.requiredFields, flyingEntity.fields)
      ) {
        anilistLog.debug('🔗 Attached to in-flight Superset request:', meta.entityKey);
        return (flyingEntity.flight as SharedFlight<T>).wait({ signal: opts.signal });
      }
    }

    const flyingExact = inflightExact.get(exactKey);
    if (flyingExact && !flyingExact.flight.controller.signal.aborted && !opts.forceFresh) {
      return (flyingExact.flight as SharedFlight<T>).wait({ signal: opts.signal });
    }

    const reqEpoch = cacheEpoch;
    const cleanupFlightRefs = (targetFlight: SharedFlight<T>) => {
      if (inflightExact.get(exactKey)?.flight === targetFlight) {
        inflightExact.delete(exactKey);
      }
      if (meta && inflightEntities.get(meta.entityKey)?.flight === targetFlight) {
        inflightEntities.delete(meta.entityKey);
      }
      maybeUnsubscribeMutationListener();
    };
    const flight = createSharedFlight<T>({
      start: (sharedSignal) =>
        executeNetworkRequest<T>(q, variables, retries, opts.forceFresh, 0, sharedSignal).then((data) => {
          if (meta && data && cacheEpoch === reqEpoch && (data as any)?.MediaListCollection?.hasNextChunk !== true) {
            const existing = entityCache.get(meta.entityKey);
            const wouldDowngrade =
              !opts.forceFresh &&
              existing &&
              Date.now() - existing.time < ENTITY_TTL &&
              isSubsetOf(meta.requiredFields, existing.fields) &&
              !isSubsetOf(existing.fields, meta.requiredFields);
            if (!wouldDowngrade) {
              entityCache.set(meta.entityKey, {
                time: Date.now(),
                data,
                isSuperset: meta.isSuperset,
                fields: meta.requiredFields
              });
            }
          }
          return data;
        }),
      onEvict: cleanupFlightRefs,
      onSettled: cleanupFlightRefs
    });

    inflightExact.set(exactKey, { flight, entityKey: meta?.entityKey });
    if (meta) {
      const existing = inflightEntities.get(meta.entityKey);
      if (!existing || existing.flight.controller.signal.aborted || (!existing.isSuperset && meta.isSuperset)) {
        inflightEntities.set(meta.entityKey, {
          flight,
          isSuperset: meta.isSuperset,
          fields: meta.requiredFields
        });
      }
    }

    return flight.wait({ signal: opts.signal });
  }

  function formatMediaListResult(mlc: any): MediaListResult {
    const rawLists = Array.isArray(mlc?.lists) ? mlc.lists : [];
    const lists: MediaListGroup[] = [];
    const seenEntryIds = new Set<number>();
    const allEntries: MediaListEntryItem[] = [];

    for (const list of rawLists) {
      if (!list || typeof list !== 'object') continue;
      const validEntries: MediaListEntryItem[] = [];
      if (Array.isArray(list.entries)) {
        for (const entry of list.entries) {
          if (!entry || typeof entry !== 'object') continue;
          validEntries.push(entry);
          if (entry.id != null) {
            if (!seenEntryIds.has(entry.id)) {
              seenEntryIds.add(entry.id);
              allEntries.push(entry);
            }
          } else {
            allEntries.push(entry);
          }
        }
      }
      lists.push({ ...list, entries: validEntries });
    }

    const mergedCollection: MediaListCollectionData = {
      user: mlc?.user,
      lists
    };

    return {
      collection: mergedCollection,
      lists,
      allEntries,
      user: mergedCollection.user
    };
  }

  function isValidFastLoadEntry(entry: any): boolean {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.mediaId !== 'number' || !Number.isFinite(entry.mediaId) || entry.mediaId <= 0) return false;
    if (!entry.media || typeof entry.media !== 'object' || typeof entry.media.id !== 'number') return false;
    if (typeof entry.status !== 'string' || !entry.status) return false;
    return true;
  }

  function isValidFastLoadMediaList(mlc: any): boolean {
    if (!mlc || typeof mlc !== 'object' || !Array.isArray(mlc.lists) || mlc.hasNextChunk === true) return false;
    for (const list of mlc.lists) {
      if (list === null) continue;
      if (typeof list !== 'object' || !Array.isArray(list.entries)) return false;
      for (const entry of list.entries) {
        if (entry === null) continue;
        if (!isValidFastLoadEntry(entry)) return false;
      }
    }
    return true;
  }

  function parseRpcMediaList(payload: any): MediaListResult | null {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.hasNextChunk === true) return null;

    const mlc = payload.MediaListCollection || payload.data?.MediaListCollection;
    if (mlc && Array.isArray(mlc.lists)) {
      if (!isValidFastLoadMediaList(mlc)) return null;
      return formatMediaListResult(mlc);
    }

    const entities = payload.entities || payload;
    const entriesMap = entities?.listEntry || entities?.mediaListEntry;
    if (entriesMap && typeof entriesMap === 'object') {
      const mediaMap = entities.media || entities.listEntryMedia || {};
      const allEntries: MediaListEntryItem[] = [];
      const normalizedById = new Map<string, MediaListEntryItem>();

      for (const [entryKey, rawEntry] of Object.entries(entriesMap) as Array<[string, any]>) {
        if (!rawEntry || typeof rawEntry !== 'object') continue;
        const mediaId =
          rawEntry.mediaId ||
          (typeof rawEntry.media === 'number' ? rawEntry.media : rawEntry.media?.id);
        if (!mediaId) continue;

        const mediaObj =
          typeof rawEntry.media === 'object' && rawEntry.media !== null
            ? rawEntry.media
            : mediaMap[mediaId] || { id: mediaId };

        const normalized: MediaListEntryItem = {
          ...rawEntry,
          mediaId,
          media: mediaObj
        };
        allEntries.push(normalized);
        normalizedById.set(entryKey, normalized);
        if (rawEntry.id != null) {
          const idKey = String(rawEntry.id);
          if (idKey !== entryKey) normalizedById.set(idKey, normalized);
        }
      }

      if (allEntries.length === 0) return null;

      const userObj = entities.user ? (Object.values(entities.user)[0] as any) : undefined;
      const lists: MediaListGroup[] = [];
      if (entities.listSection && typeof entities.listSection === 'object') {
        for (const sec of Object.values(entities.listSection) as any[]) {
          if (!sec) continue;
          lists.push({
            name: sec.name || '',
            isCustomList: !!sec.isCustomList,
            status: sec.status,
            entries: Array.isArray(sec.entries)
              ? sec.entries
                  .map((id: any) =>
                    typeof id === 'string' || typeof id === 'number' ? normalizedById.get(String(id)) : undefined
                  )
                  .filter((e: MediaListEntryItem | undefined): e is MediaListEntryItem => Boolean(e))
              : []
          });
        }
      }

      const user = userObj && userObj.id ? { id: Number(userObj.id), name: String(userObj.name || '') } : undefined;
      const collection: MediaListCollectionData = {
        lists,
        user
      };

      return {
        collection,
        allEntries,
        lists,
        user
      };
    }

    return null;
  }

  function matchMediaListKey(
    key: string,
    prefix: 'gql' | 'rpc',
    type: string,
    resolvedId?: number,
    resolvedName?: string
  ): boolean {
    const head = `${prefix}:MediaListCollection:${type.toUpperCase()}:`;
    if (!key.startsWith(head)) return false;
    const rest = key.slice(head.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return false;
    const who = rest.slice(0, sep);
    const varsSuffix = rest.slice(sep + 1);
    if (varsSuffix !== '{}') return false;
    if (resolvedId && who === String(resolvedId)) return true;
    if (resolvedName && who.toLowerCase() === resolvedName.toLowerCase()) return true;
    return false;
  }

  function lookupUserId(userMap: Map<string, number> | undefined, name?: string): number | undefined {
    if (!userMap || !name) return undefined;
    return safeBridge(() => {
      const direct = userMap.get(name);
      if (direct) return direct;
      const lower = name.toLowerCase();
      for (const [k, v] of userMap.entries()) {
        if (typeof k === 'string' && k.toLowerCase() === lower) return v;
      }
      return undefined;
    });
  }

  function lookupUserName(idMap: Map<number, string> | undefined, id?: number): string | undefined {
    if (!idMap || !id) return undefined;
    return safeBridge(() => {
      const val = idMap.get(id);
      return typeof val === 'string' ? val.trim().toLowerCase() || undefined : undefined;
    });
  }

  function resolveMediaListTarget(
    target: number | string,
    options?: { userId?: number; userName?: string }
  ): { userId?: number; userName?: string } {
    const optUserName =
      typeof options?.userName === 'string' && options.userName.trim() ? options.userName.trim() : undefined;
    const optUserId = parsePositiveId(options?.userId);

    const hasExplicitOptId = optUserId !== null;
    const hasExplicitOptName = optUserName !== undefined;

    let inferredId: number | undefined;
    let inferredName: string | undefined;

    if (!hasExplicitOptId && !hasExplicitOptName) {
      if (typeof target === 'number') {
        inferredId = parsePositiveId(target) ?? undefined;
      } else if (typeof target === 'string') {
        const trimmed = target.trim();
        if (/^\d+$/.test(trimmed)) {
          inferredId = parsePositiveId(Number(trimmed)) ?? undefined;
        } else if (trimmed) {
          inferredName = trimmed;
        }
      }
    }

    return {
      userId: optUserId ?? inferredId,
      userName: optUserName ?? inferredName
    };
  }

  function tryGetCachedMediaList(
    type: 'ANIME' | 'MANGA',
    userId?: number,
    userName?: string
  ): MediaListResult | null {
    const win = pageWin();
    const t = type.toUpperCase();
    const id = userId;
    const name = userName ? userName.toLowerCase() : undefined;

    const bridge = safeBridge(() => CoreHooks.getCacheBridge()) ?? null;
    const userMap: Map<string, number> | undefined = safeBridge(() =>
      bridge ? bridge.getUserMap() : win.__ALFL_USER_MAP__
    );
    const idMap: Map<number, string> | undefined = safeBridge(() =>
      bridge ? bridge.getIdMap() : win.__ALFL_ID_MAP__
    );

    const resolvedId = id || lookupUserId(userMap, name);
    const resolvedName = name || lookupUserName(idMap, resolvedId);

    const entityKeys: string[] = [];
    if (resolvedId) entityKeys.push(`MediaListCollection:${t}:${resolvedId}`);
    if (resolvedName) entityKeys.push(`MediaListCollection:${t}:${resolvedName}`);
    for (const k of entityKeys) {
      const cached = entityCache.get(k);
      if (
        cached &&
        Date.now() - cached.time < ENTITY_TTL &&
        cached.data?.MediaListCollection &&
        cached.data.MediaListCollection.hasNextChunk !== true &&
        cached.fields &&
        isSubsetOf(MEDIA_LIST_REQUIRED_FIELDS, cached.fields)
      ) {
        anilistLog.debug('🎯 Cache HIT for MediaListCollection via entityCache:', k);
        return formatMediaListResult(cached.data.MediaListCollection);
      }
    }

    const gqlStore: Map<string, { time: number; snap: any }> | undefined = safeBridge(() =>
      bridge ? bridge.getGqlStore() : win.__ALFL_GQL_STORE__
    );
    if (gqlStore) {
      const tryDecodeGqlEntry = (k: string, cached: any, viaScan: boolean): MediaListResult | null => {
        if (!cached || Date.now() - cached.time >= 5 * 60_000 || !cached.snap?.buf) return null;
        try {
          const raw = new TextDecoder().decode(cached.snap.buf);
          const json = JSON.parse(raw);
          const mlc = json?.data?.MediaListCollection || json?.MediaListCollection;
          if (isValidFastLoadMediaList(mlc)) {
            anilistLog.debug(
              viaScan
                ? '🎯 Cache HIT for MediaListCollection via FastLoad GQL store (scan):'
                : '🎯 Cache HIT for MediaListCollection via FastLoad GQL store:',
              k
            );
            return formatMediaListResult(mlc);
          }
        } catch (_) {}
        return null;
      };

      const gqlKeys: string[] = [];
      if (resolvedId) gqlKeys.push(`gql:MediaListCollection:${t}:${resolvedId}:{}`);
      if (resolvedName) gqlKeys.push(`gql:MediaListCollection:${t}:${resolvedName}:{}`);

      for (const k of gqlKeys) {
        const cached = safeBridge(() => gqlStore.get(k));
        const result = tryDecodeGqlEntry(k, cached, false);
        if (result) return result;
      }

      const gqlScanHit = safeBridge(() => {
        for (const [k, cached] of gqlStore.entries()) {
          if (!matchMediaListKey(k, 'gql', t, resolvedId, resolvedName)) continue;
          const result = tryDecodeGqlEntry(k, cached, true);
          if (result) return result;
        }
        return null;
      });
      if (gqlScanHit) return gqlScanHit;
    }

    const rpcCache: Map<string, { time: number; msg: any }> | undefined = safeBridge(() =>
      bridge ? bridge.getRpcCache() : win.__ALFL_RPC_CACHE__
    );
    if (rpcCache) {
      const tryParseRpcEntry = (k: string, cached: any, viaScan: boolean): MediaListResult | null => {
        if (!cached || Date.now() - cached.time >= 5 * 60_000 || !cached.msg) return null;
        try {
          const payload = cached.msg.result ?? cached.msg;
          const result = parseRpcMediaList(payload);
          if (result && result.allEntries.length > 0) {
            anilistLog.debug(
              viaScan
                ? '🎯 Cache HIT for MediaListCollection via FastLoad RPC cache (scan):'
                : '🎯 Cache HIT for MediaListCollection via FastLoad RPC cache:',
              k
            );
            return result;
          }
        } catch (_) {}
        return null;
      };

      const rpcKeys: string[] = [];
      if (resolvedId) rpcKeys.push(`rpc:MediaListCollection:${t}:${resolvedId}:{}`);
      if (resolvedName) rpcKeys.push(`rpc:MediaListCollection:${t}:${resolvedName}:{}`);

      for (const k of rpcKeys) {
        const cached = safeBridge(() => rpcCache.get(k));
        const result = tryParseRpcEntry(k, cached, false);
        if (result) return result;
      }

      const rpcScanHit = safeBridge(() => {
        for (const [k, cached] of rpcCache.entries()) {
          if (!matchMediaListKey(k, 'rpc', t, resolvedId, resolvedName)) continue;
          const result = tryParseRpcEntry(k, cached, true);
          if (result) return result;
        }
        return null;
      });
      if (rpcScanHit) return rpcScanHit;
    }

    return null;
  }

  async function getMediaList(
    target: number | string,
    type: 'ANIME' | 'MANGA' = 'ANIME',
    options?: { forceFresh?: boolean; userId?: number; userName?: string; signal?: AbortSignal }
  ): Promise<MediaListResult> {
    throwIfAborted(options?.signal);
    const { userId, userName } = resolveMediaListTarget(target, options);
    if (!userId && !userName) {
      throw new Error('Invalid AniList user target for getMediaList');
    }

    if (!options?.forceFresh) {
      const cached = tryGetCachedMediaList(type, userId, userName);
      if (cached) {
        return cached;
      }
    }

    const win = pageWin();
    const bridge = safeBridge(() => CoreHooks.getCacheBridge()) ?? null;
    const rpcInflight: Map<string, { promise: Promise<any> }> | undefined = safeBridge(() =>
      bridge ? bridge.getRpcInflight() : win.__ALFL_RPC_INFLIGHT__
    );
    if (rpcInflight && !options?.forceFresh) {
      const t = type.toUpperCase();
      const userMap: Map<string, number> | undefined = safeBridge(() =>
        bridge ? bridge.getUserMap() : win.__ALFL_USER_MAP__
      );
      const idMap: Map<number, string> | undefined = safeBridge(() =>
        bridge ? bridge.getIdMap() : win.__ALFL_ID_MAP__
      );
      const normName = userName ? userName.toLowerCase() : undefined;
      const resolvedId = userId || lookupUserId(userMap, normName);
      const resolvedName = normName || lookupUserName(idMap, resolvedId);

      const rpcKeys: string[] = [];
      if (resolvedId) rpcKeys.push(`rpc:MediaListCollection:${t}:${resolvedId}:{}`);
      if (resolvedName) rpcKeys.push(`rpc:MediaListCollection:${t}:${resolvedName}:{}`);

      const checkInflight = async (k: string, flight: { promise: Promise<any> }) => {
        if (!flight?.promise) return null;
        throwIfAborted(options?.signal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          anilistLog.debug('⏳ Awaiting in-flight FastLoad RPC prefetch:', k);
          const msg = await raceWithSignal(
            Promise.race([
              flight.promise,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), 5000);
              })
            ]),
            options?.signal
          );
          throwIfAborted(options?.signal);
          const payload = msg?.result ?? msg;
          const parsed = parseRpcMediaList(payload);
          if (parsed && parsed.allEntries.length > 0) {
            anilistLog.debug('🎯 Cache HIT from completed in-flight FastLoad RPC prefetch:', k);
            return parsed;
          }
        } catch (err) {
          if (options?.signal?.aborted) throw err;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        return null;
      };

      const seenFlights = new Set<unknown>();

      for (const k of rpcKeys) {
        const flight = safeBridge(() => rpcInflight.get(k));
        if (flight && !seenFlights.has(flight)) {
          seenFlights.add(flight);
          const res = await checkInflight(k, flight);
          if (res) return res;
        }
      }

      const matchingFlights =
        safeBridge(() => {
          const list: Array<[string, { promise: Promise<any> }]> = [];
          for (const [k, flight] of rpcInflight.entries()) {
            if (matchMediaListKey(k, 'rpc', t, resolvedId, resolvedName)) {
              list.push([k, flight]);
            }
          }
          return list;
        }) || [];
      for (const [k, flight] of matchingFlights) {
        if (seenFlights.has(flight)) continue;
        seenFlights.add(flight);
        const res = await checkInflight(k, flight);
        if (res) return res;
      }
    }

    const queryVars = {
      userId: userId || undefined,
      userName: userId ? undefined : (userName || undefined),
      type
    };

    const data = await query<{ MediaListCollection: MediaListCollectionData }>(
      MEDIA_LIST_SINGLE_QUERY,
      queryVars,
      { forceFresh: options?.forceFresh, signal: options?.signal }
    );

    const mlc = data?.MediaListCollection;
    if (!mlc || !Array.isArray(mlc.lists)) {
      throw new Error('Unexpected MediaListCollection response shape');
    }

    return formatMediaListResult(mlc);
  }

  async function viewer(forceFresh = false, opts?: { signal?: AbortSignal }): Promise<ViewerInfo | null> {
    throwIfAborted(opts?.signal);
    const doc = (pageWin().document || document) as Document;
    syncFromPage();
    if (isLoggedOutNav(doc)) {
      return null;
    }

    if (!forceFresh) {
      const name = store.get<string | null>('al_username', null);
      const fmt = store.get<string | null>('al_score_format', null);
      const id = parsePositiveId(store.get('al_user_id', null));
      if (name && fmt && id) return { id, name, scoreFormat: fmt };
    }
    if (!hasAuth()) return null;

    const myEpoch = viewerEpoch;
    const VIEWER_QUERY = 'query { Viewer { id name mediaListOptions { scoreFormat } } }';
    const fetchViewer = (fresh: boolean) =>
      query<{ Viewer: { id: number; name: string; mediaListOptions?: { scoreFormat?: string } } | null }>(
        VIEWER_QUERY,
        {},
        { forceFresh: fresh, signal: opts?.signal }
      ).catch((e) => {
        if (e?.auth || isAbortError(e) || opts?.signal?.aborted) throw e;
        return null;
      });

    const checkPostAwaitViewer = (
      res: { Viewer: { id: number; name: string; mediaListOptions?: { scoreFormat?: string } } | null } | null
    ): boolean => {
      syncFromPage();
      const mismatched = isViewerMismatchedWithPage(res?.Viewer);
      if (viewerEpoch !== myEpoch || mismatched) {
        if (viewerEpoch === myEpoch && mismatched) {
          clearViewer();
        }
        return true;
      }
      return false;
    };

    let d = await fetchViewer(forceFresh);
    throwIfAborted(opts?.signal);
    if (checkPostAwaitViewer(d)) {
      return null;
    }

    if (d?.Viewer && !d.Viewer.mediaListOptions?.scoreFormat && !forceFresh) {
      invalidateLocal('Viewer');
      d = await fetchViewer(true);
      throwIfAborted(opts?.signal);
      if (checkPostAwaitViewer(d)) {
        return null;
      }
    }

    if (d?.Viewer) {
      const scoreFormat = d.Viewer.mediaListOptions?.scoreFormat;
      if (d.Viewer.id) store.set('al_user_id', d.Viewer.id);
      if (d.Viewer.name) store.set('al_username', d.Viewer.name);
      if (scoreFormat) {
        store.set('al_score_format', scoreFormat);
      }
      return {
        id: d.Viewer.id,
        name: d.Viewer.name,
        scoreFormat: scoreFormat || ''
      };
    }
    return null;
  }

  const invalidate = (entityKeyPrefix?: string): void => {
    invalidateLocal(entityKeyPrefix);

    safeBridge(() => {
      const bridge = CoreHooks.getCacheBridge();
      if (bridge) {
        bridge.clear();
      } else {
        const win = pageWin();
        win.__ALFL_CLEAR__?.();
      }
    });
  };

  const invalidateMediaList = (target?: number | string, type?: 'ANIME' | 'MANGA'): void => {
    const who = target ? String(target).trim().toLowerCase() : '';
    if (!who) return invalidate('MediaListCollection');
    const t = type ? type.toUpperCase() : '';
    if (t) {
      invalidate(`MediaListCollection:${t}:${who}`);
      return;
    }
    invalidate(`MediaListCollection:ANIME:${who}`);
    invalidate(`MediaListCollection:MANGA:${who}`);
  };

  const hasAuth = (opts?: { reconcile?: boolean }): boolean => isBrowserLoggedIn(opts);
  const resumeAt = (): number => limiter.resumeAt;

  const session: AniListSession = {
    peek,
    get userId() {
      return peek().userId;
    },
    get username() {
      return peek().username;
    },
    get scoreFormat() {
      return peek().scoreFormat;
    },
    hasAuth,
    clear: clearViewer,
    syncFromPage,
    recordHint
  };

  return {
    query,
    getMediaList,
    viewer,
    clearViewer,
    invalidate,
    invalidateMediaList,
    hasAuth,
    resumeAt,
    session
  };
})();

export const MediaData = (() => {
  async function get(
    id: number | string,
    type: 'ANIME' | 'MANGA',
    opts?: { throwAuth?: boolean; signal?: AbortSignal }
  ): Promise<MediaEntry | null> {
    try {
      const data = await AniList.query<{ Media: MediaEntry }>(
        `query($id:Int,$type:MediaType){ Media(id:$id,type:$type){
          id idMal format title { userPreferred english romaji native }
          episodes chapters status season seasonYear nextAiringEpisode { episode }
          mediaListEntry { score progress status completedAt { year month day } }
        } }`,
        { id: Number(id), type },
        { signal: opts?.signal }
      );
      return data?.Media || null;
    } catch (e: any) {
      if (opts?.throwAuth && e?.auth) throw e;
      anilistLog.debug('MediaData fetch failed:', e?.message || e);
      return null;
    }
  }

  async function save(
    id: number | string,
    _type: 'ANIME' | 'MANGA',
    c: {
      score?: number;
      progress?: number;
      status?: string;
      completedAt?: { year: number; month: number; day: number };
    },
    opts?: { signal?: AbortSignal }
  ): Promise<NonNullable<MediaEntry['mediaListEntry']> | null> {
    const data = await AniList.query<{
      SaveMediaListEntry: NonNullable<MediaEntry['mediaListEntry']> | null;
    }>(
      `mutation($mediaId:Int!,$score:Float,$progress:Int,$status:MediaListStatus,$completedAt:FuzzyDateInput){
        SaveMediaListEntry(mediaId:$mediaId,score:$score,progress:$progress,status:$status,completedAt:$completedAt){
          score progress status completedAt { year month day }
        } }`,
      { mediaId: Number(id), score: c.score, progress: c.progress, status: c.status, completedAt: c.completedAt },
      { signal: opts?.signal }
    );
    const entry = data?.SaveMediaListEntry || null;

    AniList.invalidate(`Media:${id}`);
    AniList.invalidateMediaList();
    return entry;
  }

  return { get, save };
})();

export const anilistApiClient: AniListClient = {
  ...AniList,
  media: MediaData
};
