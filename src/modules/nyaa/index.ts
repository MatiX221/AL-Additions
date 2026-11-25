import { defineModule } from '../../core/registry';
import { icon } from '../../utils/dom';
import { openTab } from '../../utils/helpers';
import { getEffectiveMalId, isIgnored } from '../../api/malOverrides';
import type { CleanupFn, MediaRoute, MountHandle } from '../../types';

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

    const nyaaUrl = (title: string): string => {
      const q = title.trim().replace(/[^a-zA-Z0-9]+/g, '+').replace(/^\++|\++$/g, '');
      const providers = ctx.get<string[]>('nyaaProviders') || [];
      const frag = providers.map(encodeURIComponent).join('&text=');
      return `https://nyaa.si/?f=0&c=1_2&s=seeders&o=desc&q=${encodeURI(q)}#:~:text=${frag}`;
    };

    let activeLink: MountHandle | null = null;
    let activeEdit: MountHandle | null = null;
    let activeRoute: MediaRoute | null = null;
    let quickEditFn = ctx.services.get('manualOverrides:quickEdit') ?? null;

    const ensureEditMount = () => {
      if (!activeRoute || !quickEditFn) return;
      const el = activeEdit?.el();
      if (el?.isConnected) return;
      const h1 = activeLink?.el()?.parentElement || document.querySelector<HTMLElement>(H1_SEL);
      if (!h1 || !h1.isConnected) return;
      if (activeEdit) activeEdit.unmount();
      const route = activeRoute;
      activeEdit = ctx.mount({
        id: EDIT_ID,
        anchor: () => activeLink?.el()?.parentElement || document.querySelector<HTMLElement>(H1_SEL),
        position: 'beforeend',
        match: () => !!quickEditFn && activeRoute === route,
        create: () => {
          const editBtn = document.createElement('a');
          editBtn.href = '#';
          editBtn.title = 'Set or edit MyAnimeList mapping';
          editBtn.setAttribute('aria-label', 'Set or edit MyAnimeList mapping');
          editBtn.innerHTML = icon('edit', 16);
          editBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            quickEditFn?.(route.id, route.type);
          });
          return editBtn;
        }
      });
    };

    ctx.services.onAvailable('manualOverrides:quickEdit', (impl) => {
      quickEditFn = impl;
      ensureEditMount();
      return () => {
        if (quickEditFn === impl) quickEditFn = null;
        activeEdit?.unmount();
        activeEdit = null;
      };
    });

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
      void ctx.api.media.get(route.id, route.type);

      let cancelTouchTimer: CleanupFn | null = null;
      let cancelResetTimer: CleanupFn | null = null;
      const clearTouchTimers = () => {
        cancelTouchTimer?.();
        cancelTouchTimer = null;
        cancelResetTimer?.();
        cancelResetTimer = null;
      };

      const link = rc.mount({
        id: LINK_ID,
        anchor: H1_SEL,
        position: 'beforeend',
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

          rc.listen(
            a,
            'touchstart',
            ((e: TouchEvent) => {
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
            }) as EventListener,
            { passive: true }
          );

          rc.listen(
            a,
            'touchmove',
            ((e: TouchEvent) => {
              if (!cancelTouchTimer || !e.touches.length) return;
              if (Math.abs(e.touches[0].clientX - sx) > 12 || Math.abs(e.touches[0].clientY - sy) > 12) cancel();
            }) as EventListener,
            { passive: true }
          );

          rc.listen(a, 'touchend', cancel, { passive: true });
          rc.listen(a, 'touchcancel', cancel, { passive: true });
          rc.listen(a, 'contextmenu', (e) => {
            if (longPressed) e.preventDefault();
          });

          rc.listen(a, 'click', (ev: Event) => {
            const e = ev as MouseEvent;
            void (async () => {
              e.preventDefault();
            if (longPressed) {
              longPressed = false;
              e.stopPropagation();
              return;
            }
            const w = window.open('about:blank', '_blank');
            const title = titleText();
            const nyaa = nyaaUrl(title);
            let target = nyaa;
            if (!e.ctrlKey && !e.metaKey) {
              if (isIgnored(route.id)) {
                target = nyaa;
              } else {
                const media = await ctx.api.media.get(route.id, route.type);
                const effectiveMalId = getEffectiveMalId(route.id, media?.idMal);
                if (effectiveMalId) {
                  target = `https://myanimelist.net/${route.kind}/${effectiveMalId}`;
                } else {
                  target = `https://myanimelist.net/search/all?q=${encodeURIComponent(title)}&cat=all`;
                }
              }
            }
              if (w) {
                w.opener = null;
                w.location.href = target;
              } else openTab(target);
            })();
          });

          return a;
        }
      });

      activeLink = link;
      ensureEditMount();

      rc.onCleanup(() => {
        clearTouchTimers();
        if (activeLink === link) activeLink = null;
        if (activeRoute === route) activeRoute = null;
        activeEdit?.unmount();
        activeEdit = null;
      });
    });

    ctx.onCleanup(() => {
      activeEdit?.unmount();
      activeEdit = null;
      activeLink = null;
      activeRoute = null;
    });
  }
});
