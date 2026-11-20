import { mediaRoute } from '../../utils/anilistDom';
import { log } from '../../api/mal';
import { stores, addPendingDelete, removePendingDelete } from './state';
import { SyncMediaType, typeLabel } from './types';
import { getOverride } from '../../api/malOverrides';
import type { FeatureContext } from '../../types';

let activeCandidate: { mediaId: number; type: SyncMediaType; title: string; malId?: number } | null = null;

export function extractDialogMedia(root: Element = document.body): { mediaId: number; type: SyncMediaType; title: string; malId?: number } | null {
  const dialog = root.closest('.el-dialog, .el-dialog__wrapper, body')?.querySelector('.el-dialog__body') || document.querySelector('.el-dialog__body');
  if (!dialog) return null;

  const titleEl = dialog.querySelector('.title, .header .title');
  const title = titleEl?.textContent?.trim() || '';

  let type: SyncMediaType = 'ANIME';
  if (dialog.querySelector('.input-wrap.manga, .form.manga, .manga')) {
    type = 'MANGA';
  } else if (dialog.querySelector('.input-wrap.anime, .form.anime, .anime')) {
    type = 'ANIME';
  }

  let mediaId = 0;
  const vue = (dialog as any).__vue__ || (dialog.parentElement as any)?.__vue__;
  if (vue?.mediaId) mediaId = Number(vue.mediaId);
  else if (vue?.media?.id) mediaId = Number(vue.media.id);

  if (!mediaId) {
    const el = dialog.querySelector<HTMLElement>('.header[data-src], .header[style*="media/"], .cover img, img[src*="/media/"]');
    const src = el?.getAttribute('src') || el?.getAttribute('data-src') || el?.style.backgroundImage || '';
    const m = src.match(/\/media\/(anime|manga)\/[^\/]+\/(?:bx)?(\d+)/i);
    if (m) {
      type = m[1].toUpperCase() as SyncMediaType;
      mediaId = Number(m[2]);
    }
  }

  if (!mediaId && title) {
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/anime/"], a[href*="/manga/"]')).find(
      (a) => a.textContent?.trim() === title
    );
    if (link) {
      const m = link.getAttribute('href')?.match(/^\/(anime|manga)\/(\d+)/);
      if (m) {
        type = m[1].toUpperCase() as SyncMediaType;
        mediaId = Number(m[2]);
      }
    }
  }

  if (!mediaId) {
    const route = mediaRoute();
    if (route) {
      mediaId = route.id;
      type = route.type;
    }
  }

  if (!mediaId) return null;

  const override = getOverride(mediaId);
  if (override && override.malId === 0) {
    return null;
  }

  const malId = override?.malId || stores[type].ids.data[mediaId]?.m || undefined;
  return { mediaId, type, title: title || `Media #${mediaId}`, malId };
}

export function initDeletionInterceptor(ctx: FeatureContext<true>): void {
  if (typeof window === 'undefined' || location.hostname !== 'anilist.co') return;

  ctx.hooks.onGqlFetch((ev) => {
    const queryStr = ev.query || ev.operationName || '';
    if (!queryStr) return;

    if (ev.phase === 'request' && queryStr.includes('DeleteMediaListEntry')) {
      ctx.log.debug('DeleteMediaListEntry intercepted for variables:', ev.variables);
      if (ctx.get('syncMode') === 'exact') {
        const candidate = activeCandidate || extractDialogMedia(document.body);
        if (candidate) {
          addPendingDelete({
            mediaId: candidate.mediaId,
            malId: candidate.malId,
            type: candidate.type,
            title: candidate.title,
            deletedAt: Date.now()
          });
          ctx.log.debug('Queued pending deletion for exact match:', candidate);
          activeCandidate = null;
          log(`${typeLabel(candidate.type)}: queued "${candidate.title}" for deletion on MAL (Exact Match).`, 'info');
        }
      }
      return;
    }

    if (ev.phase === 'response' && queryStr.includes('SaveMediaListEntry') && ev.variables?.mediaId) {
      const mediaId = Number(ev.variables.mediaId);
      ctx.log.debug('SaveMediaListEntry intercepted, un-queuing any pending deletion for mediaId:', mediaId);
      removePendingDelete(mediaId, 'ANIME');
      removePendingDelete(mediaId, 'MANGA');
    }
  });

  ctx.listen(
    document,
    'click',
    (e) => {
      if (ctx.get('syncMode') !== 'exact') return;
      const target = e.target as HTMLElement;
      if (!target) return;

      const deleteBtn = target.closest('.delete-btn, .delete, button, [role="button"]') || target;
      const btnText = (deleteBtn.textContent || '').trim().toLowerCase();

      const isDeleteClick =
        target.classList.contains('delete-btn') ||
        target.classList.contains('delete') ||
        btnText === 'delete' ||
        btnText.includes('delete list entry');

      if (isDeleteClick) {
        const candidate = extractDialogMedia(target);
        if (candidate) {
          activeCandidate = candidate;
        }
        return;
      }

      const inWarningBox = !!target.closest('.el-message-box, .el-message-box__wrapper');
      const isOkClick =
        btnText === 'ok' ||
        target.classList.contains('el-button--primary') ||
        !!target.closest('.el-message-box__btns .el-button--primary');

      if (isOkClick && inWarningBox) {
        const candidate = activeCandidate || extractDialogMedia(document.body);
        if (candidate) {
          addPendingDelete({
            mediaId: candidate.mediaId,
            malId: candidate.malId,
            type: candidate.type,
            title: candidate.title,
            deletedAt: Date.now()
          });
          activeCandidate = null;
          log(`${typeLabel(candidate.type)}: queued "${candidate.title}" for deletion on MAL (Exact Match).`, 'info');
        }
        return;
      }

      if (btnText === 'cancel' && inWarningBox) {
        activeCandidate = null;
        return;
      }

      if (btnText === 'save' || target.classList.contains('save-btn')) {
        const candidate = extractDialogMedia(target);
        if (candidate) {
          removePendingDelete(candidate.mediaId, candidate.type);
        }
      }
    },
    true
  );

  ctx.onCleanup(() => {
    activeCandidate = null;
  });
}
