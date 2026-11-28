import { defineModule } from '../../core/registry';
import { icon } from '../../utils/dom';
import { isAbortError } from '../../utils/helpers';
import type { CleanupFn, MountHandle } from '../../types';

export function safeDecodeURIComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function sanitizeBannerSlug(raw: string): string {
  const sanitized = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') return 'anilist';
  return sanitized;
}

defineModule({
  id: 'banner',
  key: 'bannerEnabled',
  section: 'External Links, Downloads & Mappings',
  layer: 'feature',
  requiresReload: false,
  legacy: ['bannerEnabled', 'bannerDownloadEnabled', 'bannerDownloaderEnabled'],
  title: 'Anime/Manga Banner Downloader',
  help: 'Add a button for downloading the AniList banner image.',
  options: [
    {
      key: 'bannerProfiles',
      type: 'toggle',
      def: false,
      title: 'User Profile Banners',
      help: 'Also show the download button on user profile banners (it is always shown on anime and manga pages).'
    }
  ],
  setup(ctx) {
    ctx.addStyle(`
      .banner{position:relative}
      .ala-banner-dl{position:absolute;right:12px;bottom:12px;z-index:5;display:inline-flex;align-items:center;justify-content:center;height:34px;min-width:34px;padding:0 8px;border:0;border-radius:17px;background:transparent;color:rgba(255,255,255,.8);font-family:inherit;font-size:12px;font-weight:600;line-height:1;cursor:pointer;overflow:hidden;-webkit-tap-highlight-color:transparent;transition:background .15s,color .15s}
      .ala-banner-dl[hidden]{display:none}
      .ala-banner-ico{display:inline-flex;filter:drop-shadow(0 1px 3px rgba(0,0,0,.7))}
      .ala-banner-lbl{max-width:0;overflow:hidden;white-space:nowrap;transition:max-width .2s ease,margin-left .2s ease}
      .ala-banner-dl:hover,.ala-banner-dl:focus-visible{background:rgb(var(--color-blue));color:#fff}
      .ala-banner-dl:hover .ala-banner-ico,.ala-banner-dl:focus-visible .ala-banner-ico,.ala-banner-dl.is-done .ala-banner-ico{filter:none}
      .ala-banner-dl:focus-visible{outline:2px solid #fff;outline-offset:2px}
      .ala-banner-dl.is-done,.ala-banner-dl.is-done:hover{background:rgb(var(--color-green));color:#fff}
      .ala-banner-dl.is-done .ala-banner-lbl{max-width:130px;margin-left:7px}
      @media (hover:hover){.ala-banner-dl:hover .ala-banner-lbl,.ala-banner-dl:focus-visible .ala-banner-lbl{max-width:130px;margin-left:7px}}
      @media (pointer:coarse){.ala-banner-dl{right:8px;bottom:8px;height:40px;min-width:40px;border-radius:20px}}
      @media (prefers-reduced-motion:reduce){.ala-banner-lbl{transition:none}}`
    );

    const BANNER_SEL = '.banner';

    const bannerUrl = (banner: HTMLElement): string | null =>
      (banner.style.backgroundImage || getComputedStyle(banner).backgroundImage).match(
        /url\((['"]?)(.*?)\1\)/
      )?.[2] || null;

    ctx.onRoute(/^\/(?:(anime|manga)\/(\d+)|user\/([^/?#]+))(?:\/|$)/, (rc) => {
      const mediaId = rc.match?.[2];
      const userSeg = rc.match?.[3];
      if (userSeg && !ctx.get('bannerProfiles')) return;

      const rawSlug = mediaId || (userSeg ? safeDecodeURIComponent(userSeg) : 'anilist');
      const slug = sanitizeBannerSlug(rawSlug);

      let mountHandle: MountHandle<HTMLButtonElement> | null = null;
      let currentBanner: HTMLElement | null = null;
      let currentBannerUrl: string | null = null;

      function createButton(): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ala-banner-dl';
        btn.title = 'Download banner image';
        btn.setAttribute('aria-label', 'Download banner image');
        btn.innerHTML = `<span class="ala-banner-ico">${icon('download', 18)}</span><span class="ala-banner-lbl">Download banner</span>`;
        const ico = btn.firstElementChild as HTMLElement;
        const lbl = btn.lastElementChild as HTMLElement;
        let cancelResetTimer: CleanupFn | null = null;
        let downloading = false;

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (rc.signal.aborted || !btn.isConnected || downloading) return;
          const banner = btn.closest<HTMLElement>(BANNER_SEL) || document.querySelector<HTMLElement>(BANNER_SEL);
          const url = banner ? bannerUrl(banner) : null;
          if (!url) return;

          const ext = (url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i)?.[1] || 'jpg').toLowerCase();
          downloading = true;

          void rc.http
            .download(url, `anilist-banner-${slug}.${ext}`)
            .then((outcome) => {
              downloading = false;
              if (rc.signal.aborted || !btn.isConnected || !outcome) return;
              btn.classList.add('is-done');
              ico.innerHTML = icon('check', 18);
              lbl.textContent = outcome === 'tab' ? 'Opened' : 'Saved';
              cancelResetTimer?.();
              cancelResetTimer = rc.timeout(() => {
                cancelResetTimer = null;
                if (rc.signal.aborted || !btn.isConnected) return;
                btn.classList.remove('is-done');
                ico.innerHTML = icon('download', 18);
                lbl.textContent = 'Download banner';
              }, 1600);
            })
            .catch((err) => {
              downloading = false;
              if (rc.signal.aborted || isAbortError(err)) return;
              ctx.log.warn('Failed to download banner image:', err);
              ctx.toast.error('Failed to download banner image.');
            });
        });

        return btn;
      }

      const sync = (): void => {
        if (rc.signal.aborted) return;
        const banner = document.querySelector<HTMLElement>(BANNER_SEL);
        const url = banner ? bannerUrl(banner) : null;
        if (!banner || !url) {
          currentBanner = null;
          currentBannerUrl = null;
          if (mountHandle) {
            mountHandle.unmount();
            mountHandle = null;
          }
          return;
        }
        if (mountHandle && !mountHandle.el()?.isConnected) {
          mountHandle.unmount();
          mountHandle = null;
        }
        if (!mountHandle || currentBanner !== banner || currentBannerUrl !== url) {
          mountHandle?.unmount();
          currentBanner = banner;
          currentBannerUrl = url;
          mountHandle = rc.mount<HTMLButtonElement>({
            id: 'dl',
            anchor: () => document.querySelector<HTMLElement>(BANNER_SEL),
            position: 'beforeend',
            ownUi: true,
            match: () => {
              const b = document.querySelector<HTMLElement>(BANNER_SEL);
              return !!(b && bannerUrl(b));
            },
            create: createButton
          });
        }
      };

      const scheduleSync = rc.debounce(sync, 50);

      sync();
      rc.timeout(sync, 300);
      rc.onBodyMutation(scheduleSync);

      rc.ready(() => {
        if (document.body) {
          rc.observe(
            document.body,
            {
              attributes: true,
              attributeFilter: ['style', 'class'],
              subtree: true
            },
            (records) => {
              if (rc.signal.aborted) return;
              for (const r of records) {
                const target = r.target;
                if (target === currentBanner || (target instanceof Element && target.classList.contains('banner'))) {
                  scheduleSync();
                  return;
                }
              }
            }
          );
        }
      });

      rc.onCleanup(() => {
        mountHandle?.unmount();
        mountHandle = null;
        currentBanner = null;
        currentBannerUrl = null;
      });
    });
  }
});
