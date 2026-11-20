import { defineModule } from '../../core/registry';
import { findBannerElement, mediaRoute } from '../../utils/anilistDom';
import { icon } from '../../utils/dom';
import { debounce } from '../../utils/helpers';

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
    ctx.addStyle(
      'ala-banner-style',
      `
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

    const bannerUrl = (banner: HTMLElement): string | null =>
      (banner.style.backgroundImage || getComputedStyle(banner).backgroundImage).match(
        /url\((['"]?)(.*?)\1\)/
      )?.[2] || null;

    const bannerAllowed = (): boolean =>
      !!mediaRoute() || (/^\/user\//.test(location.pathname) && !!ctx.get('bannerProfiles'));

    async function download(): Promise<'download' | 'tab' | null> {
      const banner = findBannerElement();
      const url = banner && bannerAllowed() && bannerUrl(banner);
      if (!url) return null;
      const ext = (url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i)?.[1] || 'jpg').toLowerCase();
      const name = `anilist-banner-${mediaRoute()?.id || location.pathname.split('/')[2] || 'anilist'}.${ext}`;
      return ctx.http.download(url, name);
    }

    function createButton(): HTMLButtonElement {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ala-banner-dl';
      btn.title = 'Download banner image';
      btn.setAttribute('aria-label', 'Download banner image');
      btn.innerHTML = `<span class="ala-banner-ico">${icon('download', 18)}</span><span class="ala-banner-lbl">Download banner</span>`;
      const ico = btn.firstElementChild as HTMLElement;
      const lbl = btn.lastElementChild as HTMLElement;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void download()
          .then((outcome) => {
            if (!outcome) return;
            btn.classList.add('is-done');
            ico.innerHTML = icon('check', 18);
            lbl.textContent = outcome === 'tab' ? 'Opened' : 'Saved';
            ctx.timeout(() => {
              btn.classList.remove('is-done');
              ico.innerHTML = icon('download', 18);
              lbl.textContent = 'Download banner';
            }, 1600);
          })
          .catch(() => {});
      });
      return btn;
    }

    function scan(): void {
      const banner = findBannerElement();
      if (!banner) return;
      let btn = banner.querySelector<HTMLButtonElement>('.ala-banner-dl');
      const show = bannerAllowed() && !!bannerUrl(banner);
      if (!btn && !show) return;
      if (!btn) {
        btn = createButton();
        banner.appendChild(btn);
      }
      btn.hidden = !show;
    }

    const scanSoon = debounce(scan, 150);
    ctx.ready(scan);
    ctx.onNav(() => ctx.timeout(scan, 300));
    ctx.onBodyMutation(scanSoon);
    ctx.onCleanup(() => {
      document.querySelectorAll('.ala-banner-dl').forEach((el) => el.remove());
    });
  }
});
