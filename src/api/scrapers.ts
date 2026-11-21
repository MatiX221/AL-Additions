import { gm, tryOr, memo, clean } from '../utils/helpers';

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
  const nums = [...s.matchAll(/(?:^|[^\d])(?:v\d+[ ._-]*)?c?\s*(\d+(?:\.\d+)?)/gi)]
    .map((m) => Number(m[1]))
    .filter(Number.isFinite);
  if (nums.length) return Math.max(...nums);
  return Number(s.replace(/,/g, '').match(/\d+(?:\.\d+)?/)?.[0]) || null;
}

export async function mangaUpdates(title: string): Promise<number | null> {
  const search = await gm.json('https://api.mangaupdates.com/v1/series/search', {
    method: 'POST',
    anonymous: true,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    data: JSON.stringify({ search: title, stype: 'title', perpage: 8 })
  });

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
    latest = await tryOr(async () => {
      const d = await gm.json(`https://api.mangaupdates.com/v1/series/${encodeURIComponent(id)}`, {
        anonymous: true,
        headers: { Accept: 'application/json' }
      });
      return parseLatest(d?.latest_chapter ?? d?.record?.latest_chapter);
    });
  }

  if (latest == null && rec.url) {
    latest = await tryOr(async () => {
      const m = (await gm.text(rec.url, { anonymous: true })).match(
        /Latest\s+Chapter[\s\S]{0,500}?\b(?:c\s*)?(\d+(?:\.\d+)?)/i
      );
      return m ? Number(m[1]) : null;
    });
  }

  return latest == null ? null : Math.floor(latest);
}

export async function novelUpdates(title: string): Promise<number | null> {
  const html = await gm.text(`https://www.novelupdates.com/?s=${encodeURIComponent(title)}&post_type=series`, {
    anonymous: true
  });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set<string>();
  const cands: Array<{ href: string; text: string }> = [];

  for (const a of doc.querySelectorAll('a[href*="/series/"]')) {
    const href = new URL(a.getAttribute('href') || '', 'https://www.novelupdates.com/').href;
    const text = clean(a.textContent);
    if (text && !seen.has(href)) {
      seen.add(href);
      cands.push({ href, text });
    }
  }

  const best = bestMatch(cands, title, (c) => c.text);
  if (!best) return null;

  const body = new DOMParser().parseFromString(await gm.text(best.href, { anonymous: true }), 'text/html').body?.textContent || '';
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

const lookup = memo((kind: string, title: string) => (kind === 'NU' ? novelUpdates(title) : mangaUpdates(title)), {
  ttl: 30 * 60e3
});

export async function externalReleased(info: any): Promise<number | null> {
  const kind = info?.format === 'NOVEL' ? 'NU' : 'MU';
  const titles = [
    ...new Set([info?.title?.userPreferred, info?.title?.romaji, info?.title?.english].filter(Boolean))
  ];
  for (const t of titles) {
    const n = await tryOr(() => lookup(`${kind}:${normTitle(t)}`, kind, t));
    if (n != null) return n;
  }
  return null;
}