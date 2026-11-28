import { defineModule } from '../../core/registry';

defineModule({
  id: 'tagPercent',
  key: 'tagFilterEnabled',
  section: 'AniList Enhancements',
  layer: 'intercept',
  requiresReload: true,
  legacy: ['tagFilterEnabled', 'browseTagRankFilterEnabled'],
  title: 'Browse Tag Rank Filter',
  help: 'Automatically apply a minimum tag-rank percentage when you search with a tag or genre.',
  options: [
    {
      key: 'tagPercentage',
      type: 'number',
      def: 50,
      min: 1,
      max: 100,
      legacy: ['tagPercentage', 'minimumTagRankPercentage'],
      title: 'Minimum Tag Rank',
      help: 'The minimum percentage a selected tag must meet. For example, 50 means the tag must be present on at least half of the relevant titles.'
    }
  ],
  setup(ctx) {
    const PARAM = 'minimumTagRank';
    const VALUE = String(ctx.get('tagPercentage'));
    const isTarget = (): boolean => /^\/search\/(anime|manga)\/?$/.test(location.pathname);
    const hasSelection = (url: URL): boolean =>
      [...url.searchParams].some(
        ([k, v]) => k !== PARAM && !/^exclude/i.test(k) && /genre|tag/i.test(k) && v.trim() !== ''
      );
    let fixing = false;
    let appliedForFilter = false;
    let lastPathname = '';

    function apply(initial: boolean): void {
      if (fixing) return;
      if (!isTarget()) {
        appliedForFilter = false;
        lastPathname = '';
        return;
      }
      if (location.pathname !== lastPathname) {
        appliedForFilter = false;
        lastPathname = location.pathname;
      }
      const u = new URL(location.href);
      if (!hasSelection(u)) {
        appliedForFilter = false;
        return;
      }
      if (appliedForFilter || u.searchParams.has(PARAM)) {
        appliedForFilter = true;
        return;
      }
      u.searchParams.set(PARAM, VALUE);
      appliedForFilter = true;
      fixing = true;
      try {
        ctx.silently(() => {
          history.replaceState(history.state, document.title, u.toString());
          if (!initial) {
            window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
          }
        });
      } finally {
        fixing = false;
      }
    }

    apply(true);
    ctx.onNav(() => apply(false));
  }
});
