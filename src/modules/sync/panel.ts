import {
  malLimiter,
  log,
  lastNotice,
  logLines,
  exchangeMalCode,
  setMalUiSink
} from '../../api/mal';
import { tryOr, esc } from '../../utils/helpers';
import { icon } from '../../utils/dom';
import type { CleanupFn, FeatureContext, MountHandle } from '../../types';
import { progress, syncStatus, syncStore, onProgressChange, onStateChange } from './state';
import {
  startManualSync,
  fullResync,
  currentListType,
  maybeAutoSync,
  setSyncConfirm,
  LIST_PATH_RE
} from './engine';

type PanelElement = HTMLElement & { _limitCancel?: CleanupFn | null };

let panelCtx: FeatureContext<true, 'mal'> | null = null;
let activeMount: MountHandle<PanelElement> | null = null;
let routeOwner: string | null = null;
let pendingConfirm = false;

const buildPanelCss = (sel: string): string => `
  ${sel}{box-sizing:border-box;width:100%;margin-top:12px;padding:12px;border-radius:4px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font-size:13px;line-height:1.45}
  ${sel} *{box-sizing:border-box}
  ${sel} :focus-visible{outline:2px solid rgb(var(--color-blue));outline-offset:2px}
  .almal-head{display:flex;justify-content:center;margin-bottom:12px}
  .almal-flow{display:flex;align-items:center;gap:8px;min-width:0}
  .almal-arrow{flex:0 0 auto;color:rgb(var(--color-text-lighter));transition:color .2s,opacity .2s}
  .almal-flow--idle .almal-arrow{opacity:.4}
  .almal-flow--busy .almal-arrow{color:rgb(var(--color-blue))}
  .almal-flow--busy .almal-arrow-line{stroke-dasharray:4 5;animation:almal-flow .6s linear infinite}
  @keyframes almal-flow{to{stroke-dashoffset:-9}}
  .almal-chip{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:24px;padding:0 7px;border-radius:5px;color:#fff;font-size:11px;font-weight:800;letter-spacing:.02em;transition:opacity .2s}
  .almal-chip--lg{min-width:40px;height:28px;font-size:12px}
  .almal-chip.is-off{opacity:.4}
  .almal-chip--al{background:#3db4f2}
  .almal-chip--mal{background:#2e51a2}
  .almal-chip--logo{min-width:0;padding:0;background:none}
  .almal-logo{display:block;width:24px;height:24px;border-radius:6px;object-fit:contain}
  .almal-chip--lg .almal-logo{width:30px;height:30px}

  .almal-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:0 14px;border:0;border-radius:4px;background:rgba(var(--color-text),.07);color:rgb(var(--color-text));font:inherit;font-size:13px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:filter .15s,background .15s}
  .almal-btn:hover:not(:disabled){filter:brightness(1.12)}
  .almal-btn:disabled{opacity:.55;cursor:default}
  .almal-btn--primary{background:rgb(var(--color-blue));color:#fff}
  .almal-btn--primary:disabled{opacity:.75}
  .almal-btn--grow{flex:1 1 0;min-width:0;gap:5px;padding:0 8px;white-space:nowrap;overflow:hidden}
  .almal-btn--grow span{min-width:0;overflow:hidden;text-overflow:ellipsis}
  .almal-btn--icon{flex:0 0 34px;width:34px;min-width:34px;padding:0;color:rgb(var(--color-text-lighter))}
  .almal-btn--icon.is-on{background:rgba(var(--color-blue),.18);color:rgb(var(--color-blue))}
  .almal-btn--danger{color:rgb(var(--color-red,224,85,85))}
  .almal-btn--sm{min-height:32px;padding:0 12px;font-size:12px}
  .almal-btn--block{width:100%}
  .almal-actions{display:flex;gap:6px;width:100%;min-width:0}

  .almal-intro{margin:0 0 10px;color:rgb(var(--color-text-lighter));font-size:12px}
  .almal-conn{display:grid;gap:8px}
  .almal-conn-item{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:10px;border-radius:4px;background:rgb(var(--color-background))}
  .almal-conn-row{display:flex;align-items:center;gap:10px}
  .almal-conn-name{display:flex;flex-direction:column;flex:1;min-width:0;font-weight:600}
  .almal-ok{display:inline-flex;align-items:center;gap:4px;color:rgb(var(--color-green));font-size:11px;font-weight:600}
  .almal-manual{display:flex;gap:6px}
  .almal-manual input{flex:1;min-width:0;height:34px;padding:0 10px;border:1px solid rgba(var(--color-text-lighter),.22);border-radius:4px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font:inherit;font-size:12px}
  .almal-manual input:focus{outline:none;border-color:rgb(var(--color-blue))}
  .almal-hint{margin-top:10px;color:rgb(var(--color-text-lighter));font-size:12px}
  .almal-hint:empty{display:none}
  .almal-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;margin-top:8px}
  .almal-link{padding:4px 0;border:0;background:none;color:rgb(var(--color-text-lighter));font:inherit;font-size:12px;cursor:pointer}
  .almal-link:hover{color:rgb(var(--color-blue))}

  .almal-progress{height:4px;margin:12px 0 6px;border-radius:2px;background:rgba(var(--color-text),.09);overflow:hidden}
  #almal-progress-fill{height:100%;width:0%;border-radius:2px;background:rgb(var(--color-blue));transition:width .25s ease}
  #almal-progress-fill.indeterminate{width:40%!important;animation:almal-indeterminate 1.1s ease-in-out infinite}
  @keyframes almal-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
  #almal-progress-text{color:rgb(var(--color-text-lighter));font-size:12px}
  .almal-meta{display:grid;gap:3px;margin-top:10px;color:rgb(var(--color-text-lighter));font-size:12px;text-align:center}
  .almal-meta-row{white-space:nowrap}
  .almal-meta-row time{color:rgb(var(--color-text))}

  #almal-api-limit-warning{margin-top:10px;padding:8px 10px;border-radius:4px;border-left:3px solid rgb(var(--color-red,224,85,85));background:rgba(var(--color-red,224,85,85),.1);font-size:12px;line-height:1.45}
  #almal-log{max-height:220px;margin-top:10px;padding:8px 10px;border-radius:4px;background:rgb(var(--color-background));color:rgb(var(--color-text-lighter));font:11px/1.55 SFMono-Regular,Consolas,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;overflow-y:auto}

  @media (pointer:coarse){
    .almal-btn{min-height:44px}
    .almal-btn--icon{flex-basis:44px;width:44px;min-width:44px}
    .almal-btn--sm{min-height:40px}
    .almal-manual input{height:40px;font-size:16px}
    .almal-link{padding:8px 0}
  }
  @media (prefers-reduced-motion:reduce){.almal-arrow-line,#almal-progress-fill.indeterminate{animation:none}}`;

const ui = { manual: false, showLogs: false };
let progressTimer: CleanupFn | null = null;

export function updateProgressUI(force = false, targetEl?: PanelElement | null): void {
  if (!panelCtx || panelCtx.signal.aborted) return;
  if (!force) {
    if (!progressTimer)
      progressTimer = panelCtx.timeout(() => {
        progressTimer = null;
        updateProgressUI(true);
      }, 120);
    return;
  }
  const panelEl = targetEl ?? activeMount?.el() ?? null;
  renderRateLimitWarning(panelEl);
  const fill = panelEl?.querySelector<HTMLElement>('#almal-progress-fill') ?? null;
  const text = panelEl?.querySelector<HTMLElement>('#almal-progress-text') ?? null;
  if (!fill || !text) return;
  if (progress.phase === 'fetching') {
    fill.style.width = '100%';
    fill.classList.add('indeterminate');
    text.textContent = 'Checking AniList and MAL for changes…';
  } else if (progress.phase === 'pushing') {
    fill.classList.remove('indeterminate');
    fill.style.width = (progress.total ? Math.round((progress.done / progress.total) * 100) : 100) + '%';
    text.textContent = `Updating MAL: ${progress.done} / ${progress.total} checked (${progress.changed} changes)`;
  }
}

export function renderRateLimitWarning(panelEl: PanelElement | null): void {
  if (!panelEl || !panelEl.isConnected || panelCtx?.signal.aborted) return;
  const now = Date.now();
  const limited = [
    ['AniList', panelCtx?.api.resumeAt() ?? 0],
    ['MAL', malLimiter.resumeAt]
  ].filter(([, at]) => Number(at) > now);
  let warn = panelEl.querySelector<HTMLElement>('#almal-api-limit-warning');
  if (!limited.length) {
    panelEl._limitCancel?.();
    panelEl._limitCancel = null;
    warn?.remove();
    return;
  }
  if (!warn) {
    warn = document.createElement('div');
    warn.id = 'almal-api-limit-warning';
    const logBox = panelEl.querySelector('#almal-log');
    if (logBox) logBox.before(warn);
    else panelEl.appendChild(warn);
  }
  warn.innerHTML = limited
    .map(
      ([name, at]) =>
        `<b>${name} API limit reached.</b> Requests resume in <b>${Math.ceil((Number(at) - now) / 1000)}s</b>.`
    )
    .join('<br>');
  panelEl._limitCancel?.();
  panelEl._limitCancel =
    panelCtx?.timeout(() => {
      panelEl._limitCancel = null;
      renderRateLimitWarning(panelEl);
    }, 1000) ?? null;
}

const LOGOS = {
  al: {
    src: 'https://anilist.co/img/icons/android-chrome-512x512.png',
    alt: 'https://anilist.co/img/icons/favicon-32x32.png'
  },
  mal: {
    src: 'https://cdn.myanimelist.net/img/sp/icon/apple-touch-icon-256.png',
    alt: 'https://myanimelist.net/images/favicon.ico'
  }
};

const chip = (svc: 'al' | 'mal', large?: boolean, off?: boolean): string =>
  `<span class="almal-chip almal-chip--${svc} almal-chip--logo${large ? ' almal-chip--lg' : ''}${
    off ? ' is-off' : ''
  }" aria-hidden="true"><img class="almal-logo" src="${LOGOS[svc].src}" alt="" decoding="async" data-alt="${
    LOGOS[svc].alt
  }" data-fallback="${svc === 'al' ? 'AL' : 'MAL'}"></span>`;

const ARROW =
  '<svg class="almal-arrow" viewBox="0 0 40 16" width="40" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line class="almal-arrow-line" x1="2" y1="8" x2="34" y2="8"/><polyline points="30 3 36 8 30 13"/></svg>';

function ago(sec: number): string {
  if (!sec) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const timeEl = (sec: number): string =>
  `<time data-ts="${sec || 0}" title="${sec ? esc(new Date(sec * 1000).toLocaleString()) : ''}">${ago(sec)}</time>`;

const refreshTimes = (): void =>
  activeMount?.el()?.querySelectorAll<HTMLElement>('time[data-ts]').forEach((el) => {
    el.textContent = ago(Number(el.dataset.ts));
  });

function connItem(connected: boolean): string {
  const manual =
    ui.manual && !connected
      ? `<div class="almal-manual"><input id="almal-mal-manual" type="text" placeholder="Paste code" aria-label="MyAnimeList authorization code" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="almal-btn almal-btn--sm" data-act="mal-manual-save">Save</button></div>`
      : '';
  const status = connected ? `<span class="almal-ok">${icon('check', 12)}Connected</span>` : '';
  const connect = connected
    ? ''
    : `<button class="almal-btn almal-btn--primary almal-btn--sm almal-btn--block" data-act="mal-connect">Connect MyAnimeList</button>`;
  return `<div class="almal-conn-item"><div class="almal-conn-row">${chip(
    'mal',
    true
  )}<span class="almal-conn-name"><span>MyAnimeList</span>${status}</span></div>${connect}${manual}</div>`;
}

function renderPanelTo(panelEl: PanelElement): void {
  if (!panelCtx || panelCtx.signal.aborted) return;
  const alOk = panelCtx.api.hasAuth();
  const malOk = panelCtx.accounts.isConnected('mal');
  const ready = alOk && malOk;
  const tone = syncStatus.syncing ? 'busy' : ready ? 'ok' : 'idle';
  const said = {
    busy: 'Syncing from AniList to MyAnimeList',
    ok: 'AniList to MyAnimeList sync',
    idle: !alOk ? 'Log in to AniList to sync' : 'Connect MyAnimeList to sync'
  }[tone];
  let html = `<div class="almal-head"><div class="almal-flow almal-flow--${tone}" role="img" aria-label="${said}">${chip(
    'al',
    false,
    !alOk
  )}${ARROW}${chip('mal', false, !malOk)}</div></div>`;
  if (ready) {
    const t = currentListType();
    const rows = (t ? [[t, 'Last sync']] : [
      ['ANIME', 'Anime sync'],
      ['MANGA', 'Manga sync']
    ])
      .map(([type, label]) => `<div class="almal-meta-row">${label}: ${timeEl(syncStore.get('last_run_' + type, 0))}</div>`)
      .join('');
    html += `<div class="almal-actions">
        ${
          syncStatus.syncing
            ? `<button class="almal-btn almal-btn--icon almal-btn--danger" data-act="stop" ${ syncStatus.cancelled ? 'disabled' : '' } aria-label="${syncStatus.cancelled ? 'Stopping' : 'Stop sync'}" title="${ syncStatus.cancelled ? 'Stopping…' : 'Stop sync' }">${icon('stop', 16)}</button>`
            : `<button class="almal-btn almal-btn--icon" data-act="resync" ${pendingConfirm ? 'disabled' : ''} aria-label="Full resync" title="Full resync">${icon(
                'resync',
                16
              )}</button>`
        }
        <button class="almal-btn almal-btn--primary almal-btn--grow" data-act="sync" ${
          syncStatus.syncing || pendingConfirm ? 'disabled' : ''
        }><span>${syncStatus.syncing ? 'Syncing…' : 'Sync'}</span></button>
        <button class="almal-btn almal-btn--icon${ui.showLogs ? ' is-on' : ''}" data-act="logs" aria-label="Show logs" aria-pressed="${
      ui.showLogs
    }" title="Logs">${icon('list', 16)}</button>
      </div>`;
    if (syncStatus.syncing)
      html +=
        '<div class="almal-progress" role="progressbar" aria-label="Sync progress"><div id="almal-progress-fill"></div></div><div id="almal-progress-text">Starting…</div>';
    html += `<div class="almal-meta">${rows}</div>`;
  } else if (!alOk) {
    html += `<p class="almal-intro">Log in to AniList to sync your list to MyAnimeList.</p>
      <div class="almal-conn">
        <a class="almal-btn almal-btn--primary almal-btn--sm almal-btn--block" href="/login" target="_blank" style="text-decoration:none;color:#fff;text-align:center;">Log in to AniList</a>
      </div>
      <div id="almal-hint" class="almal-hint" role="status">${esc(lastNotice)}</div>
      <div class="almal-foot">
        <button class="almal-link" data-act="logs" aria-expanded="${ui.showLogs}">${ui.showLogs ? 'Hide logs' : 'Logs'}</button>
      </div>`;
  } else {
    html += `<p class="almal-intro">Connect your MyAnimeList account to copy your AniList list to MyAnimeList.</p>
      <div class="almal-conn">${connItem(malOk)}</div>
      <div id="almal-hint" class="almal-hint" role="status">${esc(lastNotice)}</div>
      <div class="almal-foot">
        <button class="almal-link" data-act="manual-toggle" aria-expanded="${ui.manual}">${
      ui.manual ? 'Hide manual entry' : 'Trouble connecting?'
    }</button>
        <button class="almal-link" data-act="logs" aria-expanded="${ui.showLogs}">${ui.showLogs ? 'Hide logs' : 'Logs'}</button>
      </div>`;
  }
  if (ui.showLogs) html += '<div id="almal-log"></div>';
  panelEl.innerHTML = html;
  panelEl.querySelectorAll<HTMLImageElement>('img.almal-logo').forEach((img) =>
    img.addEventListener('error', () => {
      if (img.dataset.alt) {
        const next = img.dataset.alt;
        img.dataset.alt = '';
        img.src = next;
        return;
      }
      const c = img.parentElement;
      if (!c) return;
      c.classList.remove('almal-chip--logo');
      c.textContent = img.dataset.fallback || '';
    })
  );
  const logBox = panelEl.querySelector<HTMLElement>('#almal-log');
  if (logBox) logBox.textContent = logLines.join('\n') || 'No activity yet.';
  if (syncStatus.syncing) updateProgressUI(true, panelEl);
  renderRateLimitWarning(panelEl);
}

export function renderPanel(): void {
  const panelEl = activeMount?.el() ?? null;
  if (panelEl) renderPanelTo(panelEl);
}

const tryAutoSync = (signal?: AbortSignal): void => {
  if (!pendingConfirm) maybeAutoSync(signal);
};

const ACTIONS: Record<string, () => void> = {
  'mal-connect': () => panelCtx?.accounts.connect('mal'),
  'manual-toggle': () => {
    ui.manual = !ui.manual;
    renderPanel();
  },
  'mal-manual-save': async () => {
    const code = (document.getElementById('almal-mal-manual') as HTMLInputElement | null)?.value.trim();
    if (!code) return;
    const ctxRef = panelCtx;
    const btn = activeMount?.el()?.querySelector<HTMLButtonElement>('[data-act="mal-manual-save"]');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      await exchangeMalCode(code);
      log('MAL connected (manual).');
      if (panelCtx !== ctxRef || ctxRef?.signal.aborted) return;
      renderPanel();
      tryAutoSync(ctxRef?.signal);
    } catch (e: any) {
      log('MAL token exchange failed: ' + (e?.message || e), 'error');
    } finally {
      if (panelCtx === ctxRef && !ctxRef?.signal.aborted && btn?.isConnected) btn.disabled = false;
    }
  },
  sync: async () => {
    const ctxRef = panelCtx;
    if (!ctxRef || ctxRef.signal.aborted || pendingConfirm) return;
    pendingConfirm = true;
    const panelEl = activeMount?.el();
    const syncBtn = panelEl?.querySelector<HTMLButtonElement>('[data-act="sync"]');
    const resyncBtn = panelEl?.querySelector<HTMLButtonElement>('[data-act="resync"]');
    if (syncBtn) syncBtn.disabled = true;
    if (resyncBtn) resyncBtn.disabled = true;
    try {
      await startManualSync(ctxRef.signal);
    } finally {
      if (panelCtx === ctxRef) {
        pendingConfirm = false;
        if (!ctxRef.signal.aborted && !syncStatus.syncing) {
          const curPanel = activeMount?.el();
          const curSync = curPanel?.querySelector<HTMLButtonElement>('[data-act="sync"]');
          const curResync = curPanel?.querySelector<HTMLButtonElement>('[data-act="resync"]');
          if (curSync) curSync.disabled = false;
          if (curResync) curResync.disabled = false;
        }
      }
    }
  },
  stop: () => {
    if (syncStatus.syncing && !syncStatus.cancelled) {
      syncStatus.cancelled = true;
      log('Stop requested. Waiting for the current API requests to finish…', 'warn');
      renderPanel();
    }
  },
  resync: async () => {
    const ctxRef = panelCtx;
    if (!ctxRef || ctxRef.signal.aborted || pendingConfirm) return;
    pendingConfirm = true;
    const panelEl = activeMount?.el();
    const resyncBtn = panelEl?.querySelector<HTMLButtonElement>('[data-act="resync"]');
    const syncBtn = panelEl?.querySelector<HTMLButtonElement>('[data-act="sync"]');
    if (resyncBtn) resyncBtn.disabled = true;
    if (syncBtn) syncBtn.disabled = true;
    try {
      const confirmed = await ctxRef.confirm({
        id: 'full-resync-confirm',
        title: 'Full Resync',
        message: 'This will re-check your entire AniList library against MAL. Continue?',
        confirmText: 'Continue',
        cancelText: 'Cancel'
      });
      if (panelCtx !== ctxRef || ctxRef.signal.aborted || !confirmed) return;
      await fullResync(ctxRef.signal);
    } finally {
      if (panelCtx === ctxRef) {
        pendingConfirm = false;
        if (!ctxRef.signal.aborted && !syncStatus.syncing) {
          const curPanel = activeMount?.el();
          const curResync = curPanel?.querySelector<HTMLButtonElement>('[data-act="resync"]');
          const curSync = curPanel?.querySelector<HTMLButtonElement>('[data-act="sync"]');
          if (curResync) curResync.disabled = false;
          if (curSync) curSync.disabled = false;
        }
      }
    }
  },
  logs: () => {
    ui.showLogs = !ui.showLogs;
    renderPanel();
  }
};

let selfLookup = false;

function decodeOwner(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function findPanelAnchor(): HTMLElement | null {
  const shuffle = document.querySelector<HTMLElement>('[title*="Random List Entry" i], [aria-label*="Random List Entry" i]');
  if (shuffle) return shuffle.parentElement || shuffle;
  if (!document.body) return null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t: Node | null; (t = walker.nextNode()); ) {
    const el = t.parentElement;
    if (t.nodeValue?.trim() === 'Sort' && el?.matches('div, section, aside') && el.parentElement) {
      return el.parentElement;
    }
  }
  return null;
}

function isOwnList(): boolean {
  let owner = routeOwner || '';
  if (!owner) {
    const m = location.pathname.match(/^\/user\/([^/]+)\/(?:anime|manga)list\/?$/i);
    if (!m) return false;
    owner = decodeOwner(m[1]);
  }
  const me = panelCtx?.session.username || '';
  if (!me && panelCtx?.api.hasAuth() && !selfLookup) {
    selfLookup = true;
    const ctxRef = panelCtx;
    void tryOr(() => ctxRef.api.viewer())
      .then((v) => {
        if (panelCtx !== ctxRef || ctxRef.signal.aborted) return;
        if (v) activeMount?.refresh();
      })
      .finally(() => {
        if (panelCtx === ctxRef) selfLookup = false;
      });
  }
  return !!me && me.toLowerCase() === owner.toLowerCase();
}

const onListRoute = (): boolean =>
  !!panelCtx && !panelCtx.signal.aborted && !!panelCtx.get('syncEnabled') && LIST_PATH_RE.test(location.pathname) && isOwnList();

function createPanelEl(): PanelElement {
  const panelEl = document.createElement('div') as PanelElement;
  panelEl.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest<HTMLElement>('[data-act]');
    if (a && a.dataset.act && ACTIONS[a.dataset.act]) ACTIONS[a.dataset.act]();
  });
  panelEl.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (e.key === 'Enter' && target?.id === 'almal-mal-manual') ACTIONS['mal-manual-save']();
  });
  return panelEl;
}

export function mountPanel(): void {
  activeMount?.refresh();
}

export function initSyncPanel(ctx: FeatureContext<true, 'mal'>): void {
  panelCtx = ctx;
  pendingConfirm = false;
  setSyncConfirm((opts) => ctx.confirm(opts));
  ctx.onCleanup(
    setMalUiSink({
      onLog: () => {
        const panelEl = activeMount?.el() ?? null;
        const hint = panelEl?.querySelector<HTMLElement>('#almal-hint');
        if (hint) hint.textContent = lastNotice;
        const logBox = panelEl?.querySelector<HTMLElement>('#almal-log');
        if (logBox) logBox.textContent = logLines.join('\n') || 'No activity yet.';
      },
      onToast: (msg, isError, closeTab) => {
        ctx.toast.show(msg, { type: isError ? 'error' : 'success', closeTab });
      }
    })
  );
  ctx.onCleanup(onProgressChange((force) => updateProgressUI(force)));
  ctx.onCleanup(onStateChange(renderPanel));

  ctx.interval(() => tryAutoSync(ctx.signal), 60_000);
  ctx.ready(() => tryAutoSync(ctx.signal));

  ctx.onRoute(/^\/user\/([^/]+)\/(?:anime|manga)list\/?$/i, (rc) => {
    routeOwner = decodeOwner(rc.match![1]);
    activeMount = rc.mount<PanelElement>({
      id: 'panel',
      anchor: findPanelAnchor,
      position: 'afterend',
      match: onListRoute,
      ownUi: true,
      style: buildPanelCss,
      create: createPanelEl,
      onMount: (el) => {
        renderPanelTo(el);
        return () => {
          el._limitCancel?.();
          el._limitCancel = null;
        };
      }
    });

    rc.onCleanup(ctx.accounts.watch('mal', () => renderPanel()));

    let lastAl: boolean | null = null;
    let lastMal: boolean | null = null;
    rc.interval(() => {
      const al = ctx.api.hasAuth();
      const mal = ctx.accounts.isConnected('mal');
      if (al !== lastAl || mal !== lastMal) {
        lastAl = al;
        lastMal = mal;
        renderPanel();
      }
      refreshTimes();
      activeMount?.refresh();
      tryAutoSync(ctx.signal);
    }, 2000);

    return () => {
      progressTimer?.();
      progressTimer = null;
      routeOwner = null;
      activeMount = null;
    };
  });

  ctx.onCleanup(() => {
    progressTimer?.();
    progressTimer = null;
    routeOwner = null;
    activeMount = null;
    selfLookup = false;
    pendingConfirm = false;
    if (panelCtx === ctx) {
      setSyncConfirm(null);
      panelCtx = null;
    }
  });
}