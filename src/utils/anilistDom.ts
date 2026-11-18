import type { MediaRoute } from '../types';

export const ANILIST_SELECTORS = {
  loginNav: 'nav a[href="/login"], .nav a[href="/login"]',
  userNav: 'nav a[href^="/user/"], .nav-wrap a[href^="/user/"], .nav a[href^="/user/"]',
  loggedInNav: 'nav a[href^="/user/"], .nav-wrap a[href^="/user/"], .user-wrap .avatar',
  mediaTitle: '.page-content .header .content > h1',
  sidebarData: '.sidebar > .data',
  overview: '.overview',
  banner: '.banner',
  filtersSlot: '.filters',
  compareRoot: '.compare',
  listWrap: '.list-wrap',
  listEntry: '.entry',
  shuffleControl: '[title*="Random List Entry" i], [aria-label*="Random List Entry" i]'
} as const;

export function decodeRouteSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function mediaRoute(pathname = location.pathname): MediaRoute | null {
  const m = pathname.match(/^\/(anime|manga)\/(\d+)(?:\/|$)/);
  return m ? { kind: m[1] as 'anime' | 'manga', type: m[1].toUpperCase() as 'ANIME' | 'MANGA', id: Number(m[2]) } : null;
}

export function listRoute(pathname = location.pathname): { owner: string; type: 'ANIME' | 'MANGA' } | null {
  const m = pathname.match(/^\/user\/([^/]+)\/(anime|manga)list(?:\/|$)/i);
  if (!m) return null;
  return {
    owner: decodeRouteSegment(m[1]),
    type: m[2].toUpperCase() === 'MANGA' ? 'MANGA' : 'ANIME'
  };
}

export function compareRoute(pathname = location.pathname): { userName: string; kind: 'anime' | 'manga'; type: 'ANIME' | 'MANGA' } | null {
  const m = pathname.match(/^\/user\/([^/]+)\/(animelist|mangalist)\/compare(?:\/|$)/i);
  if (!m) return null;
  const kind = m[2].toLowerCase().startsWith('manga') ? 'manga' : 'anime';
  return {
    userName: decodeRouteSegment(m[1]),
    kind,
    type: kind === 'manga' ? 'MANGA' : 'ANIME'
  };
}

export function staffOrStudioRoute(pathname = location.pathname): { kind: 'staff' | 'studio'; id: string } | null {
  const m = pathname.match(/^\/(staff|studio)\/(\d+)(?:\/|$)/);
  return m ? { kind: m[1] as 'staff' | 'studio', id: m[2] } : null;
}

export function isLoggedOutNav(doc: Document = document): boolean {
  return !!doc?.querySelector?.(ANILIST_SELECTORS.loginNav);
}

export function hasLoggedInNav(doc: Document = document): boolean {
  return !!doc?.querySelector?.(ANILIST_SELECTORS.loggedInNav);
}

export function navUserName(doc: Document = document): string {
  const href = doc?.querySelector?.(ANILIST_SELECTORS.userNav)?.getAttribute('href');
  const m = href && href.match(/^\/user\/([^/?#]+)/);
  return m ? decodeRouteSegment(m[1]) : '';
}

export function findMediaTitleHeader(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(ANILIST_SELECTORS.mediaTitle);
}

export function findMediaSidebarSpot(doc: Document = document): { parent: HTMLElement; before: HTMLElement } | null {
  const el = doc.querySelector<HTMLElement>(ANILIST_SELECTORS.sidebarData);
  return el?.parentElement && el.parentElement !== doc.body ? { parent: el.parentElement, before: el } : null;
}

export function findOverviewContainer(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(ANILIST_SELECTORS.overview);
}

export function findBannerElement(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(ANILIST_SELECTORS.banner);
}

export function findSyncPanelAnchor(doc: Document = document): HTMLElement | null {
  const shuffle = doc.querySelector<HTMLElement>(ANILIST_SELECTORS.shuffleControl);
  if (shuffle) return shuffle.parentElement || shuffle;
  if (!doc.body) return null;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let t: Node | null; (t = walker.nextNode()); ) {
    const el = t.parentElement;
    if (t.nodeValue?.trim() === 'Sort' && el?.matches('div, section, aside') && el.parentElement) {
      return el.parentElement;
    }
  }
  return null;
}
