import { defineModule } from '../../core/registry';
import { icon } from '../../utils/dom';
import { openTab } from '../../utils/helpers';
import { getEffectiveMalId, isIgnored } from '../../api/malOverrides';
import type { CleanupFn, MediaRoute, MountHandle, ServiceMap } from '../../types';

/** Builds a Nyaa search URL preserving Unicode letters/numbers and text-fragment provider highlights. */
export function buildNyaaUrl(title: string, providers: readonly string[] = []): string {
  const q = title
    .normalize('NFC')
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('+');
  const frag = providers.map(encodeURIComponent).join('&text=');
  return `https://nyaa.si/?f=0&c=1_2&s=seeders&o=desc&q=${q}#:~:text=${frag}`;
}

defineModule({
  id: 'nyaa',
  key: 'nyaaEnabled',
  section: 'External Links, Downloads & Mappings',
  layer: 'feature',
  requiresReload: false,
  legacy: ['nyaaEnabled', 'malNyaaLinksEnabled', 'malNyaaEnabled'],
  title: 'MyAnimeList & Nyaa Links',
  help: 'Show a MyAnimeList link, with Nyaa search available by Ctrl/Cmd-click on desktop or long-press on mobile.',
  options: [
    {
      key: 'nyaaProviders',
      type: 'list',
      def: ['SubsPlease', 'ToonsHub'],
      legacy: ['nyaaProviders', 'nyaaSearchGroups'],
      title: 'Nyaa Search Providers',
      help: 'Comma-separated provider names to include in Nyaa searches. Defaults to SubsPlease and ToonsHub.'
    }
  ],
  setup(ctx) {
    const ICON = icon('external', 17);
    const LINK_ID = ctx.getId('find-on-nyaa');
    const EDIT_ID = ctx.getId('edit-mal-id');
    const H1_SEL = '.page-content .header .content > h1';

    const nyaaUrl = (title: string): string =>
      buildNyaaUrl(title, ctx.get<string[]>('nyaaProviders') || []);

    let activeLink: MountHandle<HTMLAnchorElement> | null = null;
    let activeRoute: MediaRoute | null = null;

    ctx.events.on('manualOverrides:changed', (changedId) => {
      const linkEl = activeLink?.el();
      if (!linkEl || !activeRoute) return;
      if (changedId && Number(changedId) !== activeRoute.id) return;
      linkEl.title = isIgnored(activeRoute.id)
        ? 'Marked as AniList-Only (searches Nyaa)'
        : 'Open on MAL (Ctrl/Cmd+click or long-press: search Nyaa)';
    });

    ctx.onRoute(/^\/(anime|manga)\/(\d+)(?:\/|$)/, (rc) => {
      const kind = rc.match![1] as 'anime' | 'manga';
      const route: MediaRoute = {
        kind,
        type: kind.toUpperCase() as 'ANIME' | 'MANGA',
        id: Number(rc.match![2])
      };
      activeRoute = route;
      const pendingPopups = new Set<Window>();
      void rc.api.media.get(route.id, route.type).catch(() => null);

      let cancelTouchTimer: CleanupFn | null = null;
      let cancelResetTimer: CleanupFn | null = null;
      const clearTouchTimers = () => {
        cancelTouchTimer?.();
        cancelTouchTimer = null;
        cancelResetTimer?.();
        cancelResetTimer = null;
      };

      const link = rc.mount<HTMLAnchorElement>({
        id: LINK_ID,
        anchor: H1_SEL,
        position: 'beforeend',
        ownUi: true,
        style: (sel) =>
          `${sel},#${EDIT_ID}{display:inline-flex;align-items:center;vertical-align:middle;color:rgb(var(--color-text-lighter));opacity:.75;transition:opacity .15s,transform .15s,color .15s}${sel}{margin-left:10px}#${EDIT_ID}{margin-left:6px;cursor:pointer}${sel}:hover,#${EDIT_ID}:hover{opacity:1;color:rgb(var(--color-blue));transform:scale(1.1)}`,
        create: () => {
          clearTouchTimers();
          const a = document.createElement('a');
          a.href = '#';
          a.title = isIgnored(route.id)
            ? 'Marked as AniList-Only (searches Nyaa)'
            : 'Open on MAL (Ctrl/Cmd+click or long-press: search Nyaa)';
          a.setAttribute('aria-label', 'Open on MAL; long-press to search Nyaa');
          a.innerHTML = ICON;

          const titleText = (): string => {
            const h1 = a.parentElement;
            if (!h1) return '';
            return [...h1.childNodes]
              .filter((n) => n !== a && (n as HTMLElement)?.id !== EDIT_ID)
              .map((n) => n.textContent)
              .join('')
              .trim();
          };
          const searchNyaa = (): void => openTab(nyaaUrl(titleText()));

          let longPressed = false;
          let sx = 0;
          let sy = 0;
          const cancel = (): void => {
            cancelTouchTimer?.();
            cancelTouchTimer = null;
          };

          a.addEventListener(
            'touchstart',
            (e: TouchEvent) => {
              if (e.touches.length !== 1) return;
              sx = e.touches[0].clientX;
              sy = e.touches[0].clientY;
              longPressed = false;
              cancel();
              cancelTouchTimer = rc.timeout(() => {
                cancelTouchTimer = null;
                longPressed = true;
                searchNyaa();
                cancelResetTimer?.();
                cancelResetTimer = rc.timeout(() => {
                  longPressed = false;
                  cancelResetTimer = null;
                }, 800);
              }, 550);
            },
            { passive: true }
          );

          a.addEventListener(
            'touchmove',
            (e: TouchEvent) => {
              if (!cancelTouchTimer || !e.touches.length) return;
              if (Math.abs(e.touches[0].clientX - sx) > 12 || Math.abs(e.touches[0].clientY - sy) > 12) cancel();
            },
            { passive: true }
          );

          a.addEventListener('touchend', cancel, { passive: true });
          a.addEventListener('touchcancel', cancel, { passive: true });
          a.addEventListener('contextmenu', (e) => {
            if (longPressed) e.preventDefault();
          });

          a.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            if (longPressed) {
              longPressed = false;
              e.stopPropagation();
              return;
            }
            if (rc.signal.aborted) return;

            const title = titleText();
            const nyaa = nyaaUrl(title);
            if (e.ctrlKey || e.metaKey || isIgnored(route.id)) {
              openTab(nyaa);
              return;
            }

            const w = window.open('about:blank', '_blank');
            if (w) {
              w.opener = null;
              pendingPopups.add(w);
            }

            void (async () => {
              let media: { idMal?: number | null } | null = null;
              try {
                media = await rc.api.media.get(route.id, route.type);
              } catch {
                media = null;
              }
              if (rc.signal.aborted) {
                if (w && pendingPopups.delete(w) && !w.closed) w.close?.();
                return;
              }
              if (w?.closed) {
                pendingPopups.delete(w);
                return;
              }

              const effectiveMalId = getEffectiveMalId(route.id, media?.idMal);
              const target = effectiveMalId
                ? `https://myanimelist.net/${route.kind}/${effectiveMalId}`
                : `https://myanimelist.net/search/all?q=${encodeURIComponent(title)}&cat=all`;

              if (w) {
                pendingPopups.delete(w);
                w.location.href = target;
              } else {
                openTab(target);
              }
            })();
          });

          return a;
        }
      });

      activeLink = link;

      let currentQuickEdit: ServiceMap['manualOverrides:quickEdit'] | null = null;
      const editMount = rc.mount<HTMLAnchorElement>({
        id: EDIT_ID,
        anchor: () => link.el()?.parentElement || document.querySelector<HTMLElement>(H1_SEL),
        position: 'beforeend',
        ownUi: true,
        match: () => currentQuickEdit !== null,
        create: () => {
          const editBtn = document.createElement('a');
          editBtn.href = '#';
          editBtn.title = 'Set or edit MyAnimeList mapping';
          editBtn.setAttribute('aria-label', 'Set or edit MyAnimeList mapping');
          editBtn.innerHTML = icon('edit', 16);
          editBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentQuickEdit?.(route.id, route.type);
          });
          return editBtn;
        }
      });

      const stopQuickEditWatch = ctx.services.onAvailable('manualOverrides:quickEdit', (quickEditFn) => {
        if (rc.signal.aborted) return;
        currentQuickEdit = quickEditFn;
        editMount.refresh();
        return () => {
          if (currentQuickEdit === quickEditFn) {
            currentQuickEdit = null;
            editMount.refresh();
          }
        };
      });

      rc.onCleanup(() => {
        for (const w of pendingPopups) {
          if (!w.closed) w.close?.();
        }
        pendingPopups.clear();
        clearTouchTimers();
        stopQuickEditWatch();
        currentQuickEdit = null;
        if (activeLink === link) activeLink = null;
        if (activeRoute === route) activeRoute = null;
      });
    });

    ctx.onCleanup(() => {
      activeLink = null;
      activeRoute = null;
    });
  }
});
