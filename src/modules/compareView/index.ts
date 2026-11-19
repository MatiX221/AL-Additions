import { defineModule } from '../../core/registry';
import { debounce } from '../../utils/helpers';
import { COMPARE_CSS, COMPARE_CSS_ID } from './styles';
import { createCompareState, isComparePage, resetCompareFilters } from './data';
import { cleanupCompareView, setupCompareView } from './dom';
import { createCompareRpcBlocker, loadAllEntriesViaMediaList } from './loader';

export {
  STATUSES,
  normalizeStatus,
  getEntryMediaId,
  getEntryData,
  compareEntries,
  type EntryData
} from './data';

defineModule({
  id: 'compareView',
  key: 'compareViewEnabled',
  section: 'AniList Enhancements',
  layer: 'preload',
  requiresReload: true,
  title: 'Compare View Improvements',
  help: 'Sort lists by title or scores, auto-load complete compare list, and filter by status with responsive mobile dropdown.',
  debug: {
    key: 'debugCompareView',
    title: 'Compare View Debug',
    help: 'Log list comparison data loading, score diffs, sorting, and filtering passes.',
    pattern: /^\[COMPARE/i
  },
  setup(ctx) {
    ctx.addStyle(COMPARE_CSS_ID, COMPARE_CSS);
    ctx.ownUi('#ala-compare-sidebar');

    const state = createCompareState();
    ctx.hooks.blockRpc(createCompareRpcBlocker(state));

    const checkView = debounce(() => {
      if (state.disposed || state.isMutatingDOM) return;
      const path = location.pathname;
      if (!isComparePage()) {
        if (state.currentRoute) {
          cleanupCompareView(state);
          state.currentRoute = '';
        }
        return;
      }

      if (path !== state.currentRoute) {
        state.currentRoute = path;
        resetCompareFilters(state);
        cleanupCompareView(state);
      }

      if (state.isCompareLoaded) return;

      const compareRoot = document.querySelector<HTMLElement>('.compare:not(#ala-compare-table)');
      if (!compareRoot) return;

      const header = compareRoot.querySelector<HTMLElement>('.entry.header');
      const entries = Array.from(compareRoot.querySelectorAll<HTMLElement>('.entry:not(.header)'));

      if (!compareRoot.dataset.alaCompareInit || (!state.isCompareLoaded && entries.length !== state.lastProcessedCount)) {
        state.lastProcessedCount = entries.length;
        setupCompareView(ctx, state, compareRoot, header, entries, (root, sidebar) => {
          void loadAllEntriesViaMediaList(ctx, state, root, sidebar);
        });
      }
    }, 60);

    ctx.onRoute(() => isComparePage(), (rc) => {
      if (state.disposed) return;
      if (rc.url.pathname !== state.currentRoute) {
        state.currentRoute = rc.url.pathname;
        resetCompareFilters(state);
        cleanupCompareView(state);
      }
      checkView();
      return () => {
        state.currentRoute = '';
        cleanupCompareView(state);
      };
    });
    ctx.ready(checkView);
    ctx.onNav(checkView);
    ctx.onBodyMutation(() => {
      if (!state.disposed && isComparePage() && !state.isMutatingDOM) {
        checkView();
      }
    });
    ctx.onCleanup(() => {
      state.disposed = true;
      state.currentRoute = '';
      cleanupCompareView(state);
    });
  }
});
