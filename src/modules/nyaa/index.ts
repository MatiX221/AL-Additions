import { defineModule } from '../../core/registry';
import { icon } from '../../utils/dom';
import { openTab } from '../../utils/helpers';
import { getEffectiveMalId, isIgnored } from '../../api/malOverrides';
import type { MediaRoute } from '../../types';

const ID = 'ala-find-on-nyaa';
const EDIT_ID = 'ala-edit-mal-id';
const STYLE_ID = 'ala-nyaa-style';

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
    ctx.addStyle(
      STYLE_ID,
      `#${ID},#${EDIT_ID}{display:inline-flex;align-items:center;vertical-align:middle;color:rgb(var(--color-text-lighter));opacity:.75;transition:opacity .15s,transform .15s,color .15s}#${ID}{margin-left:10px}#${EDIT_ID}{margin-left:6px;cursor:pointer}#${ID}:hover,#${EDIT_ID}:hover{opacity:1;color:rgb(var(--color-blue));transform:scale(1.1)}`
    );

    const nyaaUrl = (title: string): string => {
      const q = title.trim().replace(/[^a-zA-Z0-9]+/g, '+').replace(/^\++|\++$/g, '');
      const providers = ctx.get<string[]>('nyaaProviders') || [];
      const frag = providers.map(encodeURIComponent).join('&text=');
      return `https://nyaa.si/?f=0&c=1_2&s=seeders&o=desc&q=${encodeURI(q)}#:~:text=${frag}`;
    };

    let activeTimerCleanup: (() => void) | null = null;
    let attachedAnchor: { h1: HTMLElement; route: MediaRoute } | null = null;
    let quickEditFn = ctx.services.get('manualOverrides:quickEdit') ?? null;

    const mountEditButton = (h1: HTMLElement, route: MediaRoute): void => {
      document.getElementById(EDIT_ID)?.remove();
      if (!quickEditFn || !h1.isConnected) return;

      const editBtn = document.createElement('a');
      editBtn.id = EDIT_ID;
      editBtn.href = '#';
      editBtn.title = 'Set or edit MyAnimeList mapping';
      editBtn.setAttribute('aria-label', 'Set or edit MyAnimeList mapping');
      editBtn.innerHTML = icon('edit', 16);
      editBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        quickEditFn?.(route.id, route.type);
      });
      h1.appendChild(editBtn);
    };

    ctx.services.onAvailable('manualOverrides:quickEdit', (impl) => {
      quickEditFn = impl;
      if (attachedAnchor) {
        mountEditButton(attachedAnchor.h1, attachedAnchor.route);
      }
      return () => {
        if (quickEditFn === impl) {
          quickEditFn = null;
        }
        document.getElementById(EDIT_ID)?.remove();
      };
    });

    ctx.events.on('manualOverrides:changed', (changedId) => {
      const linkEl = document.getElementById(ID);
      if (!linkEl || !attachedAnchor) return;
      if (changedId && Number(changedId) !== attachedAnchor.route.id) return;
      linkEl.title = isIgnored(attachedAnchor.route.id)
        ? 'Marked as AniList-Only (searches Nyaa)'
        : 'Open on MAL (Ctrl/Cmd+click or long-press: search Nyaa)';
    });

    function attach(h1: HTMLElement, route: MediaRoute): void {
      activeTimerCleanup?.();
      const a = document.createElement('a');
      a.id = ID;
      a.href = '#';
      a.title = isIgnored(route.id)
        ? 'Marked as AniList-Only (searches Nyaa)'
        : 'Open on MAL (Ctrl/Cmd+click or long-press: search Nyaa)';
      a.setAttribute('aria-label', 'Open on MAL; long-press to search Nyaa');
      a.innerHTML = ICON;

      const titleText = (): string =>
        [...h1.childNodes]
          .filter((n) => n !== a && (n as HTMLElement)?.id !== EDIT_ID)
          .map((n) => n.textContent)
          .join('')
          .trim();
      const searchNyaa = (): void => openTab(nyaaUrl(titleText()));
      void ctx.api.media.get(route.id, route.type);

      let timer: ReturnType<typeof setTimeout> | null = null;
      let longResetTimer: ReturnType<typeof setTimeout> | null = null;
      let longPressed = false;
      let sx = 0;
      let sy = 0;
      const cancel = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      activeTimerCleanup = () => {
        cancel();
        if (longResetTimer) clearTimeout(longResetTimer);
        longResetTimer = null;
      };

      a.addEventListener(
        'touchstart',
        (e) => {
          if (e.touches.length !== 1) return;
          sx = e.touches[0].clientX;
          sy = e.touches[0].clientY;
          longPressed = false;
          cancel();
          timer = setTimeout(() => {
            timer = null;
            longPressed = true;
            searchNyaa();
            longResetTimer = setTimeout(() => {
              longPressed = false;
              longResetTimer = null;
            }, 800);
          }, 550);
        },
        { passive: true }
      );

      a.addEventListener(
        'touchmove',
        (e) => {
          if (timer === null || !e.touches.length) return;
          if (Math.abs(e.touches[0].clientX - sx) > 12 || Math.abs(e.touches[0].clientY - sy) > 12) cancel();
        },
        { passive: true }
      );

      a.addEventListener('touchend', cancel, { passive: true });
      a.addEventListener('touchcancel', cancel, { passive: true });
      a.addEventListener('contextmenu', (e) => {
        if (longPressed) e.preventDefault();
      });

      a.addEventListener('click', async (e) => {
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
      });

      h1.appendChild(a);
      attachedAnchor = { h1, route };
      mountEditButton(h1, route);
    }

    ctx.onRoute(/^\/(anime|manga)\/(\d+)(?:\/|$)/, async (rc) => {
      rc.onCleanup(() => {
        activeTimerCleanup?.();
        activeTimerCleanup = null;
        attachedAnchor = null;
        document.getElementById(ID)?.remove();
        document.getElementById(EDIT_ID)?.remove();
      });
      const kind = rc.match![1] as 'anime' | 'manga';
      const route: MediaRoute = {
        kind,
        type: kind.toUpperCase() as 'ANIME' | 'MANGA',
        id: Number(rc.match![2])
      };

      const ensureMounted = () => {
        if (rc.signal.aborted || document.getElementById(ID)) return;
        const h1 = document.querySelector<HTMLElement>('.page-content .header .content > h1');
        if (h1) attach(h1, route);
      };

      const h1 = await rc.waitForSelector<HTMLElement>('.page-content .header .content > h1', 8000);
      if (rc.signal.aborted || !h1) return;
      if (!document.getElementById(ID)) attach(h1, route);

      rc.onCleanup(ctx.onBodyMutation(ensureMounted));
    });

    ctx.onCleanup(() => {
      activeTimerCleanup?.();
      activeTimerCleanup = null;
      attachedAnchor = null;
      document.getElementById(ID)?.remove();
      document.getElementById(EDIT_ID)?.remove();
    });
  }
});
