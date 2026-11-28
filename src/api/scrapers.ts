import { gm, clean, createAbortError, isAbortError, raceWithSignal } from '../utils/helpers';
import { createSharedFlight, type SharedFlight } from '../utils/flight';
import { RateLimiter } from '../utils/limiter';
import type { HttpClient } from '../types';

export type ScraperHttpClient = Pick<HttpClient, 'text' | 'json'>;

export interface ScraperOptions {
  http?: ScraperHttpClient;
  signal?: AbortSignal;
}

export const muLimiter = new RateLimiter({ rate: 30, min: 5, max: 60, burst: 3 });
export const nuLimiter = new RateLimiter({ rate: 30, min: 5, max: 60, burst: 3 });

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal);
}

async function tryScraperOrAbort<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) {
      throw signal?.aborted ? createAbortError(signal) : err;
    }
    return null;
  }
}

export const normTitle = (s: string | null | undefined): string =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’‘'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function titleScore(a: string | null | undefined, b: string | null | undefined): number {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 100;

  const wordsA = x.split(' ').filter(Boolean);
  const wordsB = y.split(' ').filter(Boolean);
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  let common = 0;
  for (const w of setA) {
    if (setB.has(w)) common++;
  }

  const totalUnique = new Set([...wordsA, ...wordsB]).size;
  const wordScore = totalUnique > 0 ? (common / totalUnique) * 100 : 0;

  const strA = ` ${x} `;
  const strB = ` ${y} `;
  const isWordSubstring = strA.includes(strB) || strB.includes(strA);

  if (isWordSubstring) {
    const lenRatio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    const subScore = Math.round(60 + lenRatio * 35);
    return Math.max(Math.round(wordScore), subScore);
  }

  return Math.round(wordScore);
}

export function bestMatch<T>(
  list: T[],
  title: string,
  getTitle: (item: T) => string | null | undefined,
  min = 70
): T | null {
  let best: T | null = null;
  let bestScore = -1;

  for (const item of list) {
    const s = titleScore(title, getTitle(item));
    if (s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best && bestScore >= min ? best : null;
}

export function parseLatest(value: unknown): number | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || /^(n\/a|unknown|none)$/i.test(s)) return null;
  const normalized = s.replace(/(?<=\d),(?=\d{3}(?!\d))/g, '');
  const nums = [...normalized.matchAll(/(?:^|[^\d])(?:v\d+[ ._-]*)?c?\s*(\d+(?:\.\d+)?)/gi)]
    .map((m) => Number(m[1]))
    .filter(Number.isFinite);
  if (nums.length) return Math.max(...nums);
  return Number(normalized.replace(/,/g, '').match(/\d+(?:\.\d+)?/)?.[0]) || null;
}

export async function mangaUpdates(title: string, opts: ScraperOptions = {}): Promise<number | null> {
  const { http = gm, signal } = opts;
  throwIfAborted(signal);

  await muLimiter.acquire({ signal });
  throwIfAborted(signal);
  const search = await raceWithSignal(
    http.json('https://api.mangaupdates.com/v1/series/search', {
      method: 'POST',
      anonymous: true,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      data: JSON.stringify({ search: title, stype: 'title', perpage: 8 }),
      signal
    }),
    signal
  );
  throwIfAborted(signal);

  const best = bestMatch(
    Array.isArray(search?.results) ? search.results : [],
    title,
    (r: any) => r?.hit_title || r?.record?.title
  );
  if (!best) return null;

  const rec = best.record || {};
  let latest = parseLatest(rec.latest_chapter);
  const id = rec.series_id || rec.id || rec.seriesId || String(rec.url || '').match(/\/series\/(\d+)/)?.[1];

  if (latest == null && id) {
    latest = await tryScraperOrAbort(async () => {
      await muLimiter.acquire({ signal });
      throwIfAborted(signal);
      const d = await raceWithSignal(
        http.json(`https://api.mangaupdates.com/v1/series/${encodeURIComponent(id)}`, {
          anonymous: true,
          headers: { Accept: 'application/json' },
          signal
        }),
        signal
      );
      throwIfAborted(signal);
      return parseLatest(d?.latest_chapter ?? d?.record?.latest_chapter);
    }, signal);
  }

  if (latest == null && rec.url) {
    latest = await tryScraperOrAbort(async () => {
      await muLimiter.acquire({ signal });
      throwIfAborted(signal);
      const text = await raceWithSignal(http.text(rec.url, { anonymous: true, signal }), signal);
      throwIfAborted(signal);
      const m = text.match(/Latest\s+Chapter[\s\S]{0,500}?\b(?:c\s*)?(\d+(?:\.\d+)?)/i);
      return m ? Number(m[1]) : null;
    }, signal);
  }

  return latest == null ? null : Math.floor(latest);
}

export async function novelUpdates(title: string, opts: ScraperOptions = {}): Promise<number | null> {
  const { http = gm, signal } = opts;
  throwIfAborted(signal);

  await nuLimiter.acquire({ signal });
  throwIfAborted(signal);
  const html = await raceWithSignal(
    http.text(`https://www.novelupdates.com/?s=${encodeURIComponent(title)}&post_type=series`, {
      anonymous: true,
      signal
    }),
    signal
  );
  throwIfAborted(signal);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set<string>();
  const cands: Array<{ href: string; text: string }> = [];

  for (const a of doc.querySelectorAll('a[href*="/series/"]')) {
    let url: URL;
    try {
      url = new URL(a.getAttribute('href') || '', 'https://www.novelupdates.com/');
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const href = url.href;
    const text = clean(a.textContent);
    if (text && !seen.has(href)) {
      seen.add(href);
      cands.push({ href, text });
    }
  }

  const best = bestMatch(cands, title, (c) => c.text);
  if (!best) return null;

  await nuLimiter.acquire({ signal });
  throwIfAborted(signal);
  const pageHtml = await raceWithSignal(http.text(best.href, { anonymous: true, signal }), signal);
  throwIfAborted(signal);
  const body = new DOMParser().parseFromString(pageHtml, 'text/html').body?.textContent || '';
  let latest: number | null = null;
  const at = body.search(/Latest\s+Release/i);
  if (at >= 0) {
    const hits = [...body.slice(at, at + 5000).matchAll(/(?:^|\s)(?:v\d+[ ._-]*)?c\s*(\d+(?:\.\d+)?)/gi)]
      .slice(0, 30)
      .map((m) => Number(m[1]))
      .filter(Number.isFinite);
    if (hits.length) latest = Math.max(...hits);
  }

  if (latest == null) {
    const m = body.slice(0, 12000).match(/(?:Status in COO|Chapters)[\s\S]{0,500}?\b(\d+(?:\.\d+)?)\s+Chapters?/i);
    if (m) latest = Number(m[1]);
  }

  return latest != null && Number.isFinite(latest) ? Math.floor(latest) : null;
}

const LOOKUP_TTL = 30 * 60e3;
const LOOKUP_MAX_ENTRIES = 1000;

const lookupCache = new Map<string, { at: number; value: number | null }>();
const lookupFlights = new Map<string, SharedFlight<number | null>>();
const transportIds = new WeakMap<object, number>();
let nextTransportId = 1;

function getTransportId(http: ScraperHttpClient): number {
  let id = transportIds.get(http);
  if (!id) {
    id = nextTransportId++;
    transportIds.set(http, id);
  }
  return id;
}

function setLookupCache(key: string, value: number | null): void {
  const now = Date.now();
  if (lookupCache.size >= LOOKUP_MAX_ENTRIES) {
    for (const [k, v] of lookupCache) {
      if (now - v.at >= LOOKUP_TTL) lookupCache.delete(k);
    }
    while (lookupCache.size >= LOOKUP_MAX_ENTRIES) {
      lookupCache.delete(lookupCache.keys().next().value as string);
    }
  }
  lookupCache.delete(key);
  lookupCache.set(key, { at: now, value });
}

function lookupRelease(
  key: string,
  kind: 'MU' | 'NU',
  title: string,
  opts: ScraperOptions = {}
): Promise<number | null> {
  throwIfAborted(opts.signal);
  const now = Date.now();
  const cached = lookupCache.get(key);
  if (cached && now - cached.at < LOOKUP_TTL) {
    return Promise.resolve(cached.value);
  }
  if (cached) lookupCache.delete(key);

  const transport = opts.http ?? gm;
  const flightKey = `${getTransportId(transport)}:${key}`;
  let flight = lookupFlights.get(flightKey);
  if (!flight || flight.controller.signal.aborted) {
    const run = kind === 'NU' ? novelUpdates : mangaUpdates;
    flight = createSharedFlight<number | null>({
      start: (sharedSignal) =>
        run(title, { http: opts.http, signal: sharedSignal }).then((v) => {
          if (!sharedSignal.aborted) {
            setLookupCache(key, v);
          }
          return v;
        }),
      onEvict: (evicted) => {
        if (lookupFlights.get(flightKey) === evicted) {
          lookupFlights.delete(flightKey);
        }
      },
      onSettled: (doneFlight) => {
        if (lookupFlights.get(flightKey) === doneFlight) {
          lookupFlights.delete(flightKey);
        }
      },
      createAbortError
    });
    lookupFlights.set(flightKey, flight);
  }

  return flight.wait({ signal: opts.signal });
}

export async function externalReleased(info: any, opts: ScraperOptions = {}): Promise<number | null> {
  throwIfAborted(opts.signal);
  const kind = info?.format === 'NOVEL' ? 'NU' : 'MU';
  const titles = [
    ...new Set([info?.title?.userPreferred, info?.title?.romaji, info?.title?.english].filter(Boolean))
  ];
  for (const t of titles) {
    throwIfAborted(opts.signal);
    const keyTitle = normTitle(t) || clean(t).toLowerCase();
    if (!keyTitle) continue;
    try {
      const n = await lookupRelease(`${kind}:${keyTitle}`, kind, t, opts);
      if (n != null) return n;
    } catch (err) {
      if (opts.signal?.aborted || isAbortError(err)) {
        throw opts.signal?.aborted ? createAbortError(opts.signal) : err;
      }
    }
  }
  return null;
}