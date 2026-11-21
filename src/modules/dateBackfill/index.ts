import type { MediaListResult } from "../../api/anilist";
import { defineModule } from "../../core/registry";

const STYLE_ID = "ala-date-backfill-style";
const MODAL_ID = "ala-date-backfill-modal";
const TARGETED_BATCH_SIZE = 10;

export type ScanMode = "TARGETED" | "FEED";
export type ScanOrder = "ASC" | "DESC";
export type ScanState = "idle" | "scanning" | "paused" | "done";

export interface FuzzyDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

export interface ListEntryCandidate {
  entryId: number;
  mediaId: number;
  mediaType: "ANIME" | "MANGA";
  title: string;
  status: string;
  repeat: number;
  startedAt: FuzzyDate;
  completedAt: FuzzyDate;
}

export interface ActivityRecord {
  id: number;
  status: string;
  progress: string | null;
  createdAt: number; // Unix timestamp (seconds)
  mediaId: number;
}

export interface ProposedDateUpdate {
  entry: ListEntryCandidate;
  newStartedAt: FuzzyDate | null;
  newCompletedAt: FuzzyDate | null;
  startSource: string | null;
  selected: boolean;
}

export interface UnresolvedCandidate {
  entry: ListEntryCandidate;
  missingLabel: string;
  ruledOutReason: string | null;
}

const ACTIVITY_PAGE_QUERY = `
query (
  $userId: Int!,
  $page: Int!,
  $types: [ActivityType!],
  $mediaIds: [Int],
  $sort: [ActivitySort!]
) {
  Page(page: $page, perPage: 50) {
    pageInfo {
      hasNextPage
      currentPage
      lastPage
    }
    activities(
      userId: $userId,
      type_in: $types,
      mediaId_in: $mediaIds,
      sort: $sort
    ) {
      ... on ListActivity {
        id
        status
        progress
        createdAt
        media { id }
      }
    }
  }
}
`;

const SAVE_ENTRY_MUTATION = `
mutation ($id: Int!, $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput) {
  SaveMediaListEntry(id: $id, startedAt: $startedAt, completedAt: $completedAt) {
    id
    startedAt { year month day }
    completedAt { year month day }
  }
}
`;

// --- Pure helpers (exported for unit testing) ---

export function normalizeFuzzyDate(
  d?: { year?: number | null; month?: number | null; day?: number | null } | null,
): FuzzyDate {
  return {
    year: d?.year ?? null,
    month: d?.month ?? null,
    day: d?.day ?? null,
  };
}

export function isDateEmpty(d: FuzzyDate | null | undefined): boolean {
  return !d || (!d.year && !d.month && !d.day);
}

export function isDateComplete(d: FuzzyDate | null | undefined): boolean {
  return Boolean(d && d.year && d.month && d.day);
}

export function formatFuzzyDate(d: FuzzyDate | null | undefined): string {
  if (!d || (!d.year && !d.month && !d.day)) return "—";
  const y = d.year ? String(d.year).padStart(4, "0") : "????";
  const m = d.month ? String(d.month).padStart(2, "0") : "??";
  const day = d.day ? String(d.day).padStart(2, "0") : "??";
  return `${y}-${m}-${day}`;
}

export function fuzzyDateFromTimestamp(unixSeconds: number): FuzzyDate {
  const dt = new Date(unixSeconds * 1000);
  return {
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
  };
}

export function compareFuzzyDates(a: FuzzyDate, b: FuzzyDate): number {
  const ay = a.year ?? 0;
  const by = b.year ?? 0;
  if (ay !== by) return ay - by;
  const am = a.month ?? 0;
  const bm = b.month ?? 0;
  if (am !== bm) return am - bm;
  return (a.day ?? 0) - (b.day ?? 0);
}

export function isFirstProgress(progress: string | null): boolean {
  if (!progress) return false;
  return /^1(?:\s*-|$)/.test(progress.trim());
}

export function entryNeedsStart(
  entry: ListEntryCandidate,
  fillPartialDates: boolean,
): boolean {
  return fillPartialDates
    ? !isDateComplete(entry.startedAt)
    : isDateEmpty(entry.startedAt);
}

export function entryNeedsFinish(
  entry: ListEntryCandidate,
  fillPartialDates: boolean,
): boolean {
  return (
    entry.status === "COMPLETED" &&
    (fillPartialDates
      ? !isDateComplete(entry.completedAt)
      : isDateEmpty(entry.completedAt))
  );
}

export function describeMissingDates(
  entry: ListEntryCandidate,
  fillPartialDates: boolean,
): string {
  const needS = entryNeedsStart(entry, fillPartialDates);
  const needF = entryNeedsFinish(entry, fillPartialDates);
  if (needS && needF) return "Start & Finish";
  if (needS) return "Start date";
  if (needF) return "Finish date";
  return "None";
}

export function chunkIds(ids: number[], size: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

export function inferDatesFromActivities(
  entry: ListEntryCandidate,
  activities: ActivityRecord[],
  fillPartialDates: boolean,
): ProposedDateUpdate | null {
  const needsStart = entryNeedsStart(entry, fillPartialDates);
  const needsFinish = entryNeedsFinish(entry, fillPartialDates);

  if (!needsStart && !needsFinish) return null;

  const sorted = [...activities].sort((a, b) => a.createdAt - b.createdAt);

  let earliestProgress: ActivityRecord | null = null;
  let earliestCompleted: ActivityRecord | null = null;
  let earliestRewatch: ActivityRecord | null = null;

  for (const act of sorted) {
    const st = act.status.trim().toLowerCase();
    if (
      (st === "watched episode" || st === "read chapter") &&
      !earliestProgress
    ) {
      earliestProgress = act;
    } else if (
      (st === "rewatched episode" || st === "reread chapter") &&
      !earliestRewatch
    ) {
      earliestRewatch = act;
    } else if (st === "completed" && !earliestCompleted) {
      earliestCompleted = act;
    }
  }

  if (
    earliestCompleted &&
    entry.repeat > 0 &&
    earliestRewatch &&
    earliestRewatch.createdAt <= earliestCompleted.createdAt
  ) {
    earliestCompleted = null;
  }

  let newCompletedAt: FuzzyDate | null = null;
  if (needsFinish && earliestCompleted) {
    const candidateFinish = fuzzyDateFromTimestamp(earliestCompleted.createdAt);
    if (
      isDateEmpty(entry.startedAt) ||
      compareFuzzyDates(entry.startedAt, candidateFinish) <= 0
    ) {
      newCompletedAt = candidateFinish;
    }
  }

  let newStartedAt: FuzzyDate | null = null;
  let startSource: string | null = null;

  if (needsStart) {
    const startAct = earliestProgress ?? earliestCompleted;
    if (startAct) {
      const candidateStart = fuzzyDateFromTimestamp(startAct.createdAt);
      const effectiveFinish = newCompletedAt ?? entry.completedAt;
      if (
        isDateEmpty(effectiveFinish) ||
        compareFuzzyDates(candidateStart, effectiveFinish) <= 0
      ) {
        newStartedAt = candidateStart;
        startSource =
          startAct.status.trim().toLowerCase() === "completed"
            ? "completed (no ep/ch log)"
            : startAct.progress
              ? `${startAct.status} ${startAct.progress}`
              : startAct.status;
      }
    }
  }

  if (!newStartedAt && !newCompletedAt) return null;

  return {
    entry,
    newStartedAt,
    newCompletedAt,
    startSource,
    selected: true,
  };
}

export function assumeStartFromFinish(
  entry: ListEntryCandidate,
  fillPartialDates: boolean,
): ProposedDateUpdate | null {
  if (!entryNeedsStart(entry, fillPartialDates)) return null;

  const hasUsableFinish = fillPartialDates
    ? isDateComplete(entry.completedAt)
    : !isDateEmpty(entry.completedAt);

  if (!hasUsableFinish) return null;
  if (compareFuzzyDates(entry.startedAt, entry.completedAt) === 0) return null;

  return {
    entry,
    newStartedAt: { ...entry.completedAt },
    newCompletedAt: null,
    startSource: "assumed from finish date (no earlier log)",
    selected: false,
  };
}

export function buildScanSnapshot(
  candidates: Map<number, ListEntryCandidate>,
  activitiesByMedia: Map<number, ActivityRecord[]>,
  ruledOutReasons: Map<number, string>,
  noEarlierLogsIds: Set<number>,
  scanDone: boolean,
  fillPartialDates: boolean,
  selectionState: Map<number, boolean>,
): { proposals: ProposedDateUpdate[]; unresolved: UnresolvedCandidate[] } {
  const proposals: ProposedDateUpdate[] = [];
  const unresolved: UnresolvedCandidate[] = [];

  for (const [mid, entry] of candidates) {
    const acts = activitiesByMedia.get(mid);
    let proposal =
      acts && acts.length > 0
        ? inferDatesFromActivities(entry, acts, fillPartialDates)
        : null;

    if (!proposal && (scanDone || noEarlierLogsIds.has(mid))) {
      proposal = assumeStartFromFinish(entry, fillPartialDates);
    }

    if (proposal) {
      const prevSelected = selectionState.get(mid);
      if (prevSelected !== undefined) {
        proposal.selected = prevSelected;
      }
      proposals.push(proposal);
    } else {
      unresolved.push({
        entry,
        missingLabel: describeMissingDates(entry, fillPartialDates),
        ruledOutReason: ruledOutReasons.get(mid) ?? null,
      });
    }
  }

  return { proposals, unresolved };
}

function isAssumedProposal(p: ProposedDateUpdate): boolean {
  return Boolean(p.startSource?.startsWith("assumed"));
}

// --- Module definition ---

defineModule({
  id: "dateBackfill",
  key: "dateBackfillEnabled",
  section: "AniList Enhancements",
  title: "Missing Date Backfill",
  help: "Query your AniList activity logs to restore missing start and completion dates on anime and manga entries.",
  requiresReload: false,
  options: [
    {
      key: "dateBackfillScope",
      type: "select",
      def: "ANIME",
      options: [
        ["ANIME", "Anime only"],
        ["MANGA", "Manga only"],
        ["BOTH", "Anime & Manga"],
      ],
      title: "Media Scope",
      help: "Which list(s) to check for missing dates.",
    },
    {
      key: "dateBackfillOrder",
      type: "select",
      def: "ASC",
      options: [
        ["ASC", "Oldest first (best for older entries)"],
        ["DESC", "Newest first (best for recent entries)"],
      ],
      title: "Activity Scan Order",
      help: "Direction to read activity pages when searching for missing dates.",
    },
    {
      key: "dateBackfillPartial",
      type: "toggle",
      def: false,
      title: "Also fix incomplete dates",
      help: "Overwrite dates missing a year, month, or day (instead of only completely blank dates).",
    },
    {
      key: "dateBackfillDelayMs",
      type: "number",
      def: 250,
      min: 0,
      max: 5000,
      title: "Extra pacing delay (ms)",
      help: "Additional pause between paginated calls on top of the built-in AniList rate limiter.",
    },
  ],
  debug: {
    label: "Date Backfill",
    title: "Date Backfill Debug",
    help: "Log list scans, activity pagination, and entry updates.",
  },
  setup(ctx) {
    let activeModalAbort: AbortController | null = null;

    ctx.onCleanup(() => {
      activeModalAbort?.abort();
      activeModalAbort = null;
      document.getElementById(MODAL_ID)?.remove();
    });

    ctx.addStyle(
      STYLE_ID,
      `@keyframes alaDbfModalIn {
        from { opacity: 0; transform: translateY(8px) scale(0.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes alaDbfIndeterminate {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(350%); }
      }
      @keyframes alaDbfPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.4; transform: scale(0.85); }
      }

      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 99999;
        background: rgba(11, 22, 34, 0.72);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        overflow-x: hidden;
      }
      #${MODAL_ID} * {
        box-sizing: border-box;
      }
      #${MODAL_ID} .ala-dbf-card {
        width: min(960px, 100%);
        max-width: 100%;
        max-height: 88vh;
        display: flex;
        flex-direction: column;
        background: rgb(var(--color-foreground));
        color: rgb(var(--color-text));
        border: 1px solid rgba(var(--color-text), 0.1);
        border-radius: 10px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        overflow: hidden;
        font-size: 1.3rem;
        animation: alaDbfModalIn 0.16s ease-out;
      }
      #${MODAL_ID} .ala-dbf-head {
        padding: 16px 22px;
        background: rgb(var(--color-background));
        border-bottom: 1px solid rgba(var(--color-text), 0.08);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex-shrink: 0;
      }
      #${MODAL_ID} .ala-dbf-title-wrap {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      #${MODAL_ID} .ala-dbf-title {
        font-size: 1.65rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: rgb(var(--color-text));
      }
      #${MODAL_ID} .ala-dbf-subtitle {
        font-size: 1.2rem;
        color: rgb(var(--color-text-lighter));
        line-height: 1.35;
      }
      #${MODAL_ID} .ala-dbf-close {
        width: 32px;
        height: 32px;
        padding: 0;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        background: rgba(var(--color-text), 0.07);
        color: rgb(var(--color-text-lighter));
        font-size: 1.5rem;
        line-height: 1;
        transition: background 0.15s, color 0.15s;
      }
      #${MODAL_ID} .ala-dbf-close:hover {
        background: rgba(var(--color-red), 0.16);
        color: rgb(var(--color-red));
      }

      /* Progress bar */
      #${MODAL_ID} .ala-dbf-progress-track {
        height: 3px;
        width: 100%;
        background: rgba(var(--color-text), 0.07);
        overflow: hidden;
        position: relative;
        flex-shrink: 0;
      }
      #${MODAL_ID} .ala-dbf-progress-fill {
        height: 100%;
        width: 0%;
        background: rgb(var(--color-blue));
        transition: width 0.25s ease;
      }
      #${MODAL_ID} .ala-dbf-progress-fill.indeterminate {
        width: 30%;
        animation: alaDbfIndeterminate 1.35s infinite ease-in-out;
      }
      #${MODAL_ID} .ala-dbf-progress-fill.applying {
        background: rgb(var(--color-green));
      }

      /* Single unified scroll container */
      #${MODAL_ID} .ala-dbf-body {
        padding: 18px 22px;
        overflow-y: auto;
        overflow-x: hidden;
        flex: 1;
        min-height: 0;
      }
      #${MODAL_ID} .ala-dbf-body::-webkit-scrollbar {
        width: 8px;
      }
      #${MODAL_ID} .ala-dbf-body::-webkit-scrollbar-thumb {
        background: rgba(var(--color-text), 0.18);
        border-radius: 4px;
      }
      #${MODAL_ID} .ala-dbf-body::-webkit-scrollbar-thumb:hover {
        background: rgba(var(--color-text), 0.3);
      }

      /* Idle Onboarding View */
      #${MODAL_ID} .ala-dbf-config-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 16px;
      }
      #${MODAL_ID} .ala-dbf-config-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 1.15rem;
        background: rgba(var(--color-text), 0.07);
        color: rgb(var(--color-text-lighter));
      }
      #${MODAL_ID} .ala-dbf-config-chip strong {
        color: rgb(var(--color-text));
        font-weight: 600;
      }
      #${MODAL_ID} .ala-dbf-mode-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 14px;
      }
      #${MODAL_ID} .ala-dbf-mode-card {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        text-align: left;
        gap: 8px;
        width: 100%;
        padding: 16px 18px;
        border-radius: 8px;
        background: rgb(var(--color-background));
        border: 1px solid rgba(var(--color-text), 0.1);
        color: rgb(var(--color-text));
        cursor: pointer;
        transition: border-color 0.15s, transform 0.12s, background 0.15s;
      }
      #${MODAL_ID} .ala-dbf-mode-card:hover {
        border-color: rgb(var(--color-blue));
        background: rgba(var(--color-blue), 0.06);
        transform: translateY(-1px);
      }
      #${MODAL_ID} .ala-dbf-mode-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        gap: 8px;
        flex-wrap: wrap;
      }
      #${MODAL_ID} .ala-dbf-mode-card-title {
        font-size: 1.4rem;
        font-weight: 700;
        color: rgb(var(--color-text));
      }
      #${MODAL_ID} .ala-dbf-mode-badge {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 1.05rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        background: rgba(var(--color-blue), 0.16);
        color: rgb(var(--color-blue));
      }
      #${MODAL_ID} .ala-dbf-mode-desc {
        font-size: 1.2rem;
        line-height: 1.45;
        color: rgb(var(--color-text-lighter));
        font-weight: 400;
      }

      /* Summary Stat Cards */
      #${MODAL_ID} .ala-dbf-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 10px;
        margin-bottom: 14px;
      }
      #${MODAL_ID} .ala-dbf-stat-card {
        padding: 10px 14px;
        border-radius: 7px;
        background: rgb(var(--color-background));
        border: 1px solid rgba(var(--color-text), 0.07);
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      #${MODAL_ID} .ala-dbf-stat-label {
        font-size: 1.1rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: rgb(var(--color-text-lighter));
        font-weight: 600;
      }
      #${MODAL_ID} .ala-dbf-stat-val {
        font-size: 1.65rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      #${MODAL_ID} .ala-dbf-stat-val.green {
        color: rgb(var(--color-green));
      }
      #${MODAL_ID} .ala-dbf-stat-val.blue {
        color: rgb(var(--color-blue));
      }

      /* Filter Toolbar */
      #${MODAL_ID} .ala-dbf-toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
        flex-wrap: wrap;
      }
      #${MODAL_ID} .ala-dbf-search {
        flex: 1;
        min-width: 180px;
        width: 100%;
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid rgba(var(--color-text), 0.14);
        background: rgb(var(--color-background));
        color: rgb(var(--color-text));
        font-size: 1.25rem;
        outline: none;
        transition: border-color 0.15s;
      }
      #${MODAL_ID} .ala-dbf-search:focus {
        border-color: rgb(var(--color-blue));
      }

      /* Sections & Tables (no nested vertical scrollbar) */
      #${MODAL_ID} .ala-dbf-section {
        margin-bottom: 16px;
        border: 1px solid rgba(var(--color-text), 0.08);
        border-radius: 8px;
        background: rgb(var(--color-background));
        overflow-x: hidden;
      }
      #${MODAL_ID} .ala-dbf-section:last-child {
        margin-bottom: 0;
      }
      #${MODAL_ID} .ala-dbf-section-head {
        padding: 10px 14px;
        background: rgba(var(--color-foreground), 0.55);
        border-bottom: 1px solid rgba(var(--color-text), 0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        font-weight: 700;
        font-size: 1.3rem;
      }
      #${MODAL_ID} .ala-dbf-section-head.collapsible {
        cursor: pointer;
        user-select: none;
      }
      #${MODAL_ID} .ala-dbf-section-head.collapsible:hover {
        background: rgba(var(--color-text), 0.05);
      }
      #${MODAL_ID} .ala-dbf-table-wrap {
        width: 100%;
        overflow-x: hidden;
      }
      #${MODAL_ID} table {
        width: 100%;
        table-layout: fixed;
        border-collapse: collapse;
        font-size: 1.25rem;
      }
      #${MODAL_ID} thead th {
        background: rgb(var(--color-background));
        color: rgb(var(--color-text-lighter));
        font-size: 1.1rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 9px 12px;
        border-bottom: 1px solid rgba(var(--color-text), 0.12);
        text-align: left;
      }
      #${MODAL_ID} tbody td {
        padding: 10px 12px;
        border-bottom: 1px solid rgba(var(--color-text), 0.06);
        vertical-align: middle;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      #${MODAL_ID} tbody tr:last-child td {
        border-bottom: none;
      }
      #${MODAL_ID} tbody tr {
        transition: background 0.12s, opacity 0.12s;
      }
      #${MODAL_ID} tbody tr:hover {
        background: rgba(var(--color-text), 0.035);
      }
      #${MODAL_ID} tbody tr.is-selected {
        background: rgba(var(--color-blue), 0.055);
      }
      #${MODAL_ID} tbody tr.is-unselected {
        opacity: 0.72;
      }
      #${MODAL_ID} input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: rgb(var(--color-blue));
        cursor: pointer;
        vertical-align: middle;
      }

      /* Links, Badges & Date Diffs */
      #${MODAL_ID} .ala-dbf-media-link {
        color: rgb(var(--color-text));
        text-decoration: none;
        font-weight: 600;
        transition: color 0.12s;
      }
      #${MODAL_ID} .ala-dbf-media-link:hover {
        color: rgb(var(--color-blue));
        text-decoration: underline;
      }
      #${MODAL_ID} .ala-dbf-type-badge {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 1rem;
        font-weight: 700;
        letter-spacing: 0.03em;
        background: rgba(var(--color-blue), 0.15);
        color: rgb(var(--color-blue));
        vertical-align: middle;
      }
      #${MODAL_ID} .ala-dbf-type-badge.manga {
        background: rgba(var(--color-green), 0.15);
        color: rgb(var(--color-green));
      }
      #${MODAL_ID} .ala-dbf-date-diff {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        font-variant-numeric: tabular-nums;
      }
      #${MODAL_ID} .ala-dbf-old-date {
        color: rgb(var(--color-text-lighter));
      }
      #${MODAL_ID} .ala-dbf-arrow {
        color: rgb(var(--color-text-lighter));
        font-size: 1.1rem;
      }
      #${MODAL_ID} .ala-dbf-new-date {
        display: inline-block;
        padding: 2px 7px;
        border-radius: 4px;
        background: rgba(var(--color-green), 0.15);
        color: rgb(var(--color-green));
        font-weight: 700;
      }
      #${MODAL_ID} .ala-dbf-new-date.assumed {
        background: rgba(235, 168, 52, 0.16);
        color: rgb(235, 168, 52);
      }
      #${MODAL_ID} .ala-dbf-source {
        margin-top: 3px;
        font-size: 1.1rem;
        color: rgb(var(--color-text-lighter));
      }
      #${MODAL_ID} .ala-dbf-source.assumed {
        color: rgb(235, 168, 52);
      }
      #${MODAL_ID} .ala-dbf-pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 1.1rem;
        font-weight: 600;
        background: rgba(var(--color-text), 0.1);
        color: rgb(var(--color-text));
      }
      #${MODAL_ID} .ala-dbf-empty-note {
        padding: 16px 14px;
        margin: 0;
        color: rgb(var(--color-text-lighter));
        font-size: 1.25rem;
      }

      /* Footer & Buttons */
      #${MODAL_ID} .ala-dbf-foot {
        padding: 13px 22px;
        background: rgb(var(--color-background));
        border-top: 1px solid rgba(var(--color-text), 0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        flex-shrink: 0;
      }
      #${MODAL_ID} .ala-dbf-status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: rgb(var(--color-text-lighter));
        font-size: 1.2rem;
        min-width: 0;
      }
      #${MODAL_ID} .ala-dbf-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: rgb(var(--color-text-lighter));
        flex-shrink: 0;
      }
      #${MODAL_ID} .ala-dbf-dot.active {
        background: rgb(var(--color-blue));
        animation: alaDbfPulse 1.1s infinite ease-in-out;
      }
      #${MODAL_ID} .ala-dbf-dot.paused {
        background: rgb(235, 168, 52);
      }
      #${MODAL_ID} .ala-dbf-dot.done {
        background: rgb(var(--color-green));
      }
      #${MODAL_ID} .ala-dbf-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      #${MODAL_ID} .ala-dbf-actions[hidden] {
        display: none;
      }
      #${MODAL_ID} button.ala-dbf-btn {
        padding: 7px 14px;
        border: 1px solid transparent;
        border-radius: 6px;
        cursor: pointer;
        font-size: 1.25rem;
        font-weight: 600;
        background: rgb(var(--color-blue));
        color: #fff;
        transition: filter 0.14s, background 0.14s, opacity 0.14s;
      }
      #${MODAL_ID} button.ala-dbf-btn:hover:not(:disabled) {
        filter: brightness(1.08);
      }
      #${MODAL_ID} button.ala-dbf-btn.secondary {
        background: rgba(var(--color-text), 0.1);
        color: rgb(var(--color-text));
      }
      #${MODAL_ID} button.ala-dbf-btn.secondary:hover:not(:disabled) {
        background: rgba(var(--color-text), 0.16);
      }
      #${MODAL_ID} button.ala-dbf-btn.apply {
        background: rgb(var(--color-green));
        color: #fff;
      }
      #${MODAL_ID} button.ala-dbf-btn.mini {
        padding: 5px 10px;
        font-size: 1.15rem;
      }
      #${MODAL_ID} button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      /* Mobile Responsive Rules: full-width footer buttons & zero horizontal scroll */
      @media (max-width: 640px) {
        #${MODAL_ID} {
          padding: 10px;
        }
        #${MODAL_ID} .ala-dbf-card {
          max-height: 92vh;
        }
        #${MODAL_ID} .ala-dbf-head {
          padding: 12px 14px;
        }
        #${MODAL_ID} .ala-dbf-body {
          padding: 12px 14px;
        }
        #${MODAL_ID} .ala-dbf-mode-grid {
          grid-template-columns: 1fr;
        }
        #${MODAL_ID} .ala-dbf-stats {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        #${MODAL_ID} .ala-dbf-search {
          font-size: 16px;
        }
        #${MODAL_ID} .ala-dbf-foot {
          padding: 12px 14px;
          flex-direction: column;
          align-items: stretch;
        }
        #${MODAL_ID} .ala-dbf-actions {
          display: flex;
          flex-direction: column;
          width: 100%;
        }
        #${MODAL_ID} .ala-dbf-actions[hidden] {
          display: none;
        }
        #${MODAL_ID} .ala-dbf-foot button.ala-dbf-btn {
          width: 100%;
          padding: 10px 14px;
          text-align: center;
        }

        /* Convert tables to stacked cards on mobile so horizontal scroll is impossible */
        #${MODAL_ID} table,
        #${MODAL_ID} tbody,
        #${MODAL_ID} tr,
        #${MODAL_ID} td {
          display: block;
          width: 100%;
        }
        #${MODAL_ID} thead {
          display: none;
        }
        #${MODAL_ID} tbody tr {
          padding: 10px 12px;
          border-bottom: 1px solid rgba(var(--color-text), 0.08);
        }
        #${MODAL_ID} tbody tr:last-child {
          border-bottom: none;
        }
        #${MODAL_ID} tbody td {
          padding: 4px 0;
          border-bottom: none;
        }
        #${MODAL_ID} tbody td.ala-dbf-check-cell {
          float: left;
          width: 28px;
          padding-top: 2px;
        }
        #${MODAL_ID} tbody td.ala-dbf-title-cell {
          padding-left: 28px;
          margin-bottom: 4px;
        }
        #${MODAL_ID} tbody td.ala-dbf-unresolved-title {
          margin-bottom: 4px;
        }
        #${MODAL_ID} tbody td[data-label] {
          display: flex;
          align-items: baseline;
          gap: 8px;
          padding-left: 28px;
          font-size: 1.2rem;
        }
        #${MODAL_ID} tbody td.ala-dbf-unresolved-meta[data-label] {
          padding-left: 0;
        }
        #${MODAL_ID} tbody td[data-label]::before {
          content: attr(data-label);
          flex-shrink: 0;
          min-width: 54px;
          font-size: 1.1rem;
          font-weight: 700;
          text-transform: uppercase;
          color: rgb(var(--color-text-lighter));
        }
      }`,
    );

    async function resolveUserId(): Promise<number | null> {
      if (ctx.session.userId) return ctx.session.userId;
      if (!ctx.session.hasAuth()) return null;
      const viewer = await ctx.api.viewer();
      return viewer?.id ?? null;
    }

    function openModal() {
      activeModalAbort?.abort();
      const modalAbort = new AbortController();
      activeModalAbort = modalAbort;

      let activeScanAbort: AbortController | null = null;
      modalAbort.signal.addEventListener("abort", () => {
        activeScanAbort?.abort();
        activeScanAbort = null;
      });

      document.getElementById(MODAL_ID)?.remove();
      const overlay = document.createElement("div");
      overlay.id = MODAL_ID;
      const untrackOwnUi = ctx.ownUi(`#${MODAL_ID}`);

      const closeModal = () => {
        modalAbort.abort();
        untrackOwnUi();
        overlay.remove();
      };

      const renderIdleScreenHtml = () => {
        const scopeSetting = ctx.get<string>("dateBackfillScope");
        const orderSetting = ctx.get<ScanOrder>("dateBackfillOrder");
        const partialSetting = ctx.get<boolean>("dateBackfillPartial");

        const scopeLabel =
          scopeSetting === "BOTH"
            ? "Anime & Manga"
            : scopeSetting === "MANGA"
              ? "Manga only"
              : "Anime only";
        const orderLabelSetting =
          orderSetting === "DESC" ? "Newest first" : "Oldest first";

        return `
          <div class="ala-dbf-config-bar">
            <span class="ala-dbf-config-chip">Scope: <strong>${scopeLabel}</strong></span>
            <span class="ala-dbf-config-chip">Order: <strong>${orderLabelSetting}</strong></span>
            <span class="ala-dbf-config-chip">Incomplete dates: <strong>${partialSetting ? "Include" : "Blank only"}</strong></span>
          </div>
          <div class="ala-dbf-mode-grid">
            <button type="button" class="ala-dbf-mode-card" data-act="scan-fast">
              <div class="ala-dbf-mode-card-head">
                <span class="ala-dbf-mode-card-title">Fast Scan</span>
                <span class="ala-dbf-mode-badge">Recommended</span>
              </div>
              <span class="ala-dbf-mode-desc">
                Queries activity history filtered directly to titles missing dates in batches of 10 (identical to Social → Recent Activity → Self).
              </span>
            </button>
            <button type="button" class="ala-dbf-mode-card" data-act="scan-full">
              <div class="ala-dbf-mode-card-head">
                <span class="ala-dbf-mode-card-title">Full Feed Scan</span>
              </div>
              <span class="ala-dbf-mode-desc">
                Walks your entire account activity feed chronologically from start to finish. Useful as a fallback if targeted queries miss anything.
              </span>
            </button>
          </div>
        `;
      };

      overlay.innerHTML = `
        <div class="ala-dbf-card" role="dialog" aria-modal="true" aria-label="Missing Date Backfill">
          <div class="ala-dbf-head">
            <div class="ala-dbf-title-wrap">
              <div class="ala-dbf-title">Missing Date Backfill</div>
              <div class="ala-dbf-subtitle">Recover missing start and completion dates from your AniList activity logs</div>
            </div>
            <button type="button" class="ala-dbf-close" data-act="close" title="Close">✕</button>
          </div>
          <div class="ala-dbf-progress-track">
            <div class="ala-dbf-progress-fill" data-role="progress"></div>
          </div>
          <div class="ala-dbf-body" data-role="body">
            ${renderIdleScreenHtml()}
          </div>
          <div class="ala-dbf-foot">
            <div class="ala-dbf-status">
              <span class="ala-dbf-dot" data-role="dot"></span>
              <span data-role="status">Ready to scan</span>
            </div>
            <div class="ala-dbf-actions" data-role="footer-actions" hidden>
              <button type="button" class="ala-dbf-btn secondary" data-act="primary-action">Pause</button>
              <button type="button" class="ala-dbf-btn apply" data-act="apply" disabled>Apply Selected (0)</button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const bodyEl = overlay.querySelector('[data-role="body"]') as HTMLElement;
      const statusEl = overlay.querySelector('[data-role="status"]') as HTMLElement;
      const dotEl = overlay.querySelector('[data-role="dot"]') as HTMLElement;
      const progressEl = overlay.querySelector('[data-role="progress"]') as HTMLElement;
      const footerActionsEl = overlay.querySelector('[data-role="footer-actions"]') as HTMLElement;
      const primaryActionBtn = overlay.querySelector('[data-act="primary-action"]') as HTMLButtonElement;
      const applyBtn = overlay.querySelector('[data-act="apply"]') as HTMLButtonElement;

      let scanState: ScanState = "idle";
      let activeMode: ScanMode = "TARGETED";
      let pauseRequested = false;
      let resumeResolver: (() => void) | null = null;
      let wakeSleepFn: (() => void) | null = null;
      let filterQuery = "";
      let unresolvedCollapsed = false;

      let candidates = new Map<number, ListEntryCandidate>();
      let activitiesByMedia = new Map<number, ActivityRecord[]>();
      let seenActivityIds = new Set<number>();
      let ruledOutReasons = new Map<number, string>();
      let noEarlierLogsIds = new Set<number>();
      let selectionState = new Map<number, boolean>();
      let proposals: ProposedDateUpdate[] = [];
      let unresolved: UnresolvedCandidate[] = [];
      let appliedCount = 0;

      const modeLabel = (mode: ScanMode) =>
        mode === "TARGETED" ? "Fast Scan" : "Full Feed Scan";

      const setProgress = (
        pct: number | null,
        variant: "scanning" | "applying" | "idle" = "scanning",
      ) => {
        progressEl.classList.remove("indeterminate", "applying");
        if (variant === "applying") progressEl.classList.add("applying");

        if (variant === "idle") {
          progressEl.style.width = "0%";
        } else if (pct === null) {
          progressEl.style.width = "";
          progressEl.classList.add("indeterminate");
        } else {
          progressEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        }
      };

      const setStatusIndicator = (
        tone: "idle" | "active" | "paused" | "done",
        text: string,
      ) => {
        dotEl.className = `ala-dbf-dot ${tone === "idle" ? "" : tone}`.trim();
        statusEl.textContent = text;
      };

      const sleepInterruptible = (ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          if (ms <= 0 || pauseRequested) {
            resolve();
            return;
          }
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            wakeSleepFn = null;
            signal.removeEventListener("abort", onAbort);
            resolve();
          };
          const cancelTimer = ctx.timeout(finish, ms);
          const onAbort = () => {
            if (done) return;
            done = true;
            wakeSleepFn = null;
            cancelTimer();
            reject(new DOMException("Aborted", "AbortError"));
          };
          wakeSleepFn = () => {
            cancelTimer();
            finish();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });

      const waitIfPaused = (signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          if (!pauseRequested) {
            resolve();
            return;
          }
          setScanState("paused");
          setProgress(null, "idle");
          refreshSnapshotAndRender();
          setStatusIndicator(
            "paused",
            `Paused (${modeLabel(activeMode)}) — ${proposals.length} found, ${unresolved.length} not yet found.`,
          );

          const onAbort = () => {
            resumeResolver = null;
            reject(new DOMException("Aborted", "AbortError"));
          };
          resumeResolver = () => {
            signal.removeEventListener("abort", onAbort);
            resumeResolver = null;
            pauseRequested = false;
            setScanState("scanning");
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });

      const updateButtons = () => {
        if (scanState === "idle") {
          footerActionsEl.hidden = true;
          return;
        }

        footerActionsEl.hidden = false;
        const selectedCount = proposals.filter((p) => p.selected).length;
        applyBtn.textContent = `Apply Selected (${selectedCount})`;

        if (scanState === "scanning") {
          primaryActionBtn.disabled = pauseRequested;
          primaryActionBtn.textContent = pauseRequested ? "Pausing..." : "Pause";
          primaryActionBtn.className = "ala-dbf-btn secondary";
          applyBtn.disabled = true;
        } else if (scanState === "paused") {
          primaryActionBtn.disabled = false;
          primaryActionBtn.textContent = "Resume Scan";
          primaryActionBtn.className = "ala-dbf-btn";
          applyBtn.disabled = selectedCount === 0;
        } else {
          // done: offer the complementary scan mode alongside Apply Selected
          primaryActionBtn.disabled = false;
          primaryActionBtn.textContent =
            activeMode === "TARGETED" ? "Full Feed Scan" : "Fast Scan";
          primaryActionBtn.className = "ala-dbf-btn";
          applyBtn.disabled = selectedCount === 0;
        }
      };

      const setScanState = (next: ScanState) => {
        scanState = next;
        updateButtons();
      };

      const resetToIdleScreen = () => {
        activeScanAbort?.abort();
        activeScanAbort = null;
        pauseRequested = false;
        resumeResolver = null;
        wakeSleepFn = null;
        candidates.clear();
        activitiesByMedia.clear();
        seenActivityIds.clear();
        ruledOutReasons.clear();
        noEarlierLogsIds.clear();
        selectionState.clear();
        proposals = [];
        unresolved = [];
        appliedCount = 0;
        filterQuery = "";
        unresolvedCollapsed = false;

        setScanState("idle");
        setProgress(0, "idle");
        setStatusIndicator("idle", "Ready to scan");
        bodyEl.innerHTML = renderIdleScreenHtml();
      };

      const ensureResultsScaffold = (): HTMLElement => {
        let resultsContainer = bodyEl.querySelector(
          '[data-role="results"]',
        ) as HTMLElement | null;

        if (!resultsContainer) {
          bodyEl.innerHTML = `
            <div class="ala-dbf-toolbar">
              <button
                type="button"
                class="ala-dbf-btn secondary mini"
                data-act="back-idle"
                ${scanState === "scanning" ? "disabled" : ""}
                title="Return to scan mode selection"
              >← Modes</button>
              <input
                type="search"
                class="ala-dbf-search"
                data-role="filter"
                placeholder="Filter entries by title..."
                value="${escapeHtml(filterQuery)}"
              />
            </div>
            <div data-role="results"></div>
          `;
          resultsContainer = bodyEl.querySelector(
            '[data-role="results"]',
          ) as HTMLElement;
        } else {
          const backBtn = bodyEl.querySelector(
            '[data-act="back-idle"]',
          ) as HTMLButtonElement | null;
          if (backBtn) backBtn.disabled = scanState === "scanning";
        }
        return resultsContainer;
      };

      const refreshSnapshotAndRender = () => {
        const fillPartial = ctx.get<boolean>("dateBackfillPartial");
        const snap = buildScanSnapshot(
          candidates,
          activitiesByMedia,
          ruledOutReasons,
          noEarlierLogsIds,
          scanState === "done",
          fillPartial,
          selectionState,
        );
        proposals = snap.proposals;
        unresolved = snap.unresolved;
        renderResults();
        updateButtons();
      };

      ctx.listen(overlay, "click", (ev) => {
        const target = (ev.target as HTMLElement).closest(
          "[data-act]",
        ) as HTMLElement | null;
        if (!target) {
          if (ev.target === overlay) closeModal();
          return;
        }
        const act = target.dataset.act;
        if (act === "close") {
          closeModal();
        } else if (act === "scan-fast") {
          void runScan("TARGETED");
        } else if (act === "scan-full") {
          void runScan("FEED");
        } else if (act === "back-idle") {
          if (scanState !== "scanning") {
            resetToIdleScreen();
          }
        } else if (act === "primary-action") {
          if (scanState === "scanning" && !pauseRequested) {
            pauseRequested = true;
            updateButtons();
            wakeSleepFn?.();
          } else if (scanState === "paused" && resumeResolver) {
            resumeResolver();
          } else if (scanState === "done") {
            const nextMode: ScanMode =
              activeMode === "TARGETED" ? "FEED" : "TARGETED";
            void runScan(nextMode);
          }
        } else if (act === "apply") {
          void runApply();
        } else if (act === "toggle-all") {
          const allSelected =
            proposals.length > 0 && proposals.every((p) => p.selected);
          const nextVal = !allSelected;
          for (const p of proposals) {
            p.selected = nextVal;
            selectionState.set(p.entry.mediaId, nextVal);
          }
          renderResults();
          updateButtons();
        } else if (act === "select-confirmed") {
          for (const p of proposals) {
            const nextVal = !isAssumedProposal(p);
            p.selected = nextVal;
            selectionState.set(p.entry.mediaId, nextVal);
          }
          renderResults();
          updateButtons();
        } else if (act === "toggle-unresolved") {
          unresolvedCollapsed = !unresolvedCollapsed;
          renderResults();
        }
      });

      ctx.listen(overlay, "input", (ev) => {
        const input = ev.target as HTMLInputElement;
        if (input.dataset.role === "filter") {
          filterQuery = input.value;
          renderResults();
        }
      });

      ctx.listen(overlay, "change", (ev) => {
        const input = ev.target as HTMLInputElement;
        if (input.type === "checkbox" && input.dataset.mediaId !== undefined) {
          const mediaId = Number(input.dataset.mediaId);
          selectionState.set(mediaId, input.checked);
          const found = proposals.find((p) => p.entry.mediaId === mediaId);
          if (found) {
            found.selected = input.checked;
            const row = input.closest("tr");
            if (row) {
              row.classList.toggle("is-selected", input.checked);
              row.classList.toggle("is-unselected", !input.checked);
            }
            updateButtons();
          }
        }
      });

      const formatRateLimitHint = () => {
        const resumeAt = ctx.api.resumeAt();
        if (resumeAt <= Date.now()) return "";
        const secs = Math.max(1, Math.ceil((resumeAt - Date.now()) / 1000));
        return ` (rate-limit pause: ${secs}s)`;
      };

      async function runScan(mode: ScanMode) {
        activeScanAbort?.abort();
        const scanAbort = new AbortController();
        activeScanAbort = scanAbort;
        const signal = scanAbort.signal;

        const userId = await resolveUserId();
        if (signal.aborted) return;
        if (!userId) {
          ctx.toast.error("Please log in to AniList first.");
          return;
        }

        activeMode = mode;
        pauseRequested = false;
        resumeResolver = null;
        filterQuery = "";
        unresolvedCollapsed = false;
        candidates = new Map<number, ListEntryCandidate>();
        activitiesByMedia = new Map<number, ActivityRecord[]>();
        seenActivityIds = new Set<number>();
        ruledOutReasons = new Map<number, string>();
        noEarlierLogsIds = new Set<number>();
        selectionState = new Map<number, boolean>();
        proposals = [];
        unresolved = [];
        appliedCount = 0;

        setScanState("scanning");
        setProgress(null, "scanning");
        bodyEl.innerHTML = `<p class="ala-dbf-empty-note">Fetching your list entries...</p>`;

        const scope = ctx.get<string>("dateBackfillScope");
        const order = ctx.get<ScanOrder>("dateBackfillOrder");
        const fillPartial = ctx.get<boolean>("dateBackfillPartial");
        const delayMs = ctx.get<number>("dateBackfillDelayMs");

        const mediaTypes: Array<"ANIME" | "MANGA"> =
          scope === "BOTH" ? ["ANIME", "MANGA"] : [scope as "ANIME" | "MANGA"];
        const sortDir = order === "DESC" ? "ID_DESC" : "ID";

        try {
          for (const type of mediaTypes) {
            setStatusIndicator(
              "active",
              `Loading ${type.toLowerCase()} list...${formatRateLimitHint()}`,
            );
            const listRes: MediaListResult = await ctx.api.getMediaList(
              userId,
              type,
            );
            if (signal.aborted) return;

            for (const raw of listRes.allEntries) {
              if (raw.status === "PLANNING") continue;
              const cand: ListEntryCandidate = {
                entryId: raw.id,
                mediaId: raw.mediaId,
                mediaType: type,
                title:
                  raw.media?.title?.userPreferred ||
                  raw.media?.title?.romaji ||
                  raw.media?.title?.english ||
                  `Media #${raw.mediaId}`,
                status: raw.status,
                repeat: raw.repeat ?? 0,
                startedAt: normalizeFuzzyDate(raw.startedAt),
                completedAt: normalizeFuzzyDate(raw.completedAt),
              };

              if (
                entryNeedsStart(cand, fillPartial) ||
                entryNeedsFinish(cand, fillPartial)
              ) {
                candidates.set(cand.mediaId, cand);
              }
            }
          }

          if (candidates.size === 0) {
            setScanState("done");
            setProgress(100, "idle");
            setStatusIndicator(
              "done",
              "Done — no entries with missing dates found.",
            );
            bodyEl.innerHTML = `<p class="ala-dbf-empty-note">All checked list entries already have dates set!</p>`;
            return;
          }

          ctx.log.debug(
            "Candidates missing dates:",
            candidates.size,
            "mode:",
            mode,
            "order:",
            sortDir,
          );
          refreshSnapshotAndRender();

          const resolvedIds = new Set<number>();
          const foundStart = new Set<number>();
          const foundFinish = new Set<number>();
          const confirmedFirstEp = new Set<number>();
          const activityTypes = mediaTypes.map((t) => `${t}_LIST`);

          const ingestActivities = (
            activities: Array<{
              id?: number;
              status?: string;
              progress?: string | null;
              createdAt?: number;
              media?: { id: number };
            }>,
            effectiveOrder: ScanOrder,
          ) => {
            for (const act of activities) {
              if (!act.media || !act.id || !act.status || !act.createdAt) {
                continue;
              }
              if (seenActivityIds.has(act.id)) continue;
              seenActivityIds.add(act.id);

              const mid = act.media.id;
              const cand = candidates.get(mid);
              if (!cand || resolvedIds.has(mid)) continue;

              const st = act.status.trim().toLowerCase();

              if (effectiveOrder === "ASC") {
                if (
                  !isDateEmpty(cand.completedAt) &&
                  compareFuzzyDates(
                    fuzzyDateFromTimestamp(act.createdAt),
                    cand.completedAt,
                  ) > 0
                ) {
                  resolvedIds.add(mid);
                  noEarlierLogsIds.add(mid);
                  if (!foundStart.has(mid) && !foundFinish.has(mid)) {
                    ruledOutReasons.set(
                      mid,
                      "Passed completion date without earlier log",
                    );
                  }
                  continue;
                }

                if (
                  (st === "rewatched episode" || st === "reread chapter") &&
                  !foundStart.has(mid) &&
                  !foundFinish.has(mid)
                ) {
                  resolvedIds.add(mid);
                  noEarlierLogsIds.add(mid);
                  ruledOutReasons.set(mid, "Only rewatch/reread logs exist");
                  continue;
                }
              }

              const list = activitiesByMedia.get(mid) ?? [];
              list.push({
                id: act.id,
                status: act.status,
                progress: act.progress ?? null,
                createdAt: act.createdAt,
                mediaId: mid,
              });
              activitiesByMedia.set(mid, list);

              if (st === "watched episode" || st === "read chapter") {
                foundStart.add(mid);
                if (isFirstProgress(act.progress ?? null)) {
                  confirmedFirstEp.add(mid);
                }
              } else if (st === "completed") {
                foundStart.add(mid);
                foundFinish.add(mid);
              }

              if (effectiveOrder === "ASC") {
                const startDone =
                  !entryNeedsStart(cand, fillPartial) || foundStart.has(mid);
                const finishDone =
                  !entryNeedsFinish(cand, fillPartial) || foundFinish.has(mid);
                if (startDone && finishDone) {
                  resolvedIds.add(mid);
                }
              } else {
                const startDone =
                  !entryNeedsStart(cand, fillPartial) ||
                  confirmedFirstEp.has(mid);
                const finishDone =
                  !entryNeedsFinish(cand, fillPartial) ||
                  (foundFinish.has(mid) && cand.repeat === 0);
                if (startDone && finishDone) {
                  resolvedIds.add(mid);
                }
              }
            }
          };

          if (mode === "TARGETED") {
            const batches = chunkIds(
              Array.from(candidates.keys()),
              TARGETED_BATCH_SIZE,
            );

            for (let bIdx = 0; bIdx < batches.length; bIdx += 1) {
              if (signal.aborted) return;

              let activeIds = batches[bIdx].filter(
                (id) => candidates.has(id) && !resolvedIds.has(id),
              );
              let page = 1;
              let hasNextPage = true;

              while (
                activeIds.length > 0 &&
                hasNextPage &&
                !signal.aborted
              ) {
                if (pauseRequested) {
                  await waitIfPaused(signal);
                  activeIds = activeIds.filter(
                    (id) => candidates.has(id) && !resolvedIds.has(id),
                  );
                  if (activeIds.length === 0) break;
                }

                const singleCand =
                  activeIds.length === 1 ? candidates.get(activeIds[0]) : null;
                const useFinishShortcut =
                  order === "ASC" &&
                  page > 1 &&
                  singleCand != null &&
                  singleCand.repeat === 0 &&
                  (!entryNeedsStart(singleCand, fillPartial) ||
                    foundStart.has(singleCand.mediaId)) &&
                  entryNeedsFinish(singleCand, fillPartial) &&
                  !foundFinish.has(singleCand.mediaId);

                const querySort: ScanOrder = useFinishShortcut ? "DESC" : order;
                const queryPage = useFinishShortcut ? 1 : page;

                setProgress(
                  Math.round((bIdx / batches.length) * 100),
                  "scanning",
                );
                setStatusIndicator(
                  "active",
                  `Fast Scan batch ${bIdx + 1}/${batches.length} (page ${queryPage}) — ${proposals.length} found, ${candidates.size - resolvedIds.size} searching...${formatRateLimitHint()}`,
                );

                const pageData = await ctx.api.query<{
                  Page: {
                    pageInfo: { hasNextPage: boolean; lastPage: number };
                    activities: Array<{
                      id?: number;
                      status?: string;
                      progress?: string | null;
                      createdAt?: number;
                      media?: { id: number };
                    }>;
                  };
                }>(ACTIVITY_PAGE_QUERY, {
                  userId,
                  page: queryPage,
                  types: activityTypes,
                  mediaIds: activeIds,
                  sort: [querySort === "DESC" ? "ID_DESC" : "ID"],
                });

                if (signal.aborted) return;

                ingestActivities(pageData.Page.activities, querySort);
                refreshSnapshotAndRender();

                if (useFinishShortcut) {
                  break;
                }

                const nextActiveIds = activeIds.filter(
                  (id) => candidates.has(id) && !resolvedIds.has(id),
                );
                hasNextPage = pageData.Page.pageInfo.hasNextPage;

                if (nextActiveIds.length === 0 || !hasNextPage) {
                  break;
                }

                if (nextActiveIds.length < activeIds.length) {
                  activeIds = nextActiveIds;
                  page = 1;
                } else {
                  page += 1;
                }

                if (pauseRequested) {
                  await waitIfPaused(signal);
                } else {
                  await sleepInterruptible(delayMs, signal);
                  if (pauseRequested) {
                    await waitIfPaused(signal);
                  }
                }
              }
            }
          } else {
            let page = 1;
            let hasNextPage = true;

            while (hasNextPage && !signal.aborted) {
              if (pauseRequested) {
                await waitIfPaused(signal);
              }
              if (candidates.size === 0) break;

              const orderLabel = order === "DESC" ? "newest" : "oldest";
              setProgress(null, "scanning");
              setStatusIndicator(
                "active",
                `Full Feed Scan (${orderLabel} page ${page}) — ${proposals.length} found, ${candidates.size - resolvedIds.size} searching...${formatRateLimitHint()}`,
              );

              const pageData = await ctx.api.query<{
                Page: {
                  pageInfo: { hasNextPage: boolean; lastPage: number };
                  activities: Array<{
                    id?: number;
                    status?: string;
                    progress?: string | null;
                    createdAt?: number;
                    media?: { id: number };
                  }>;
                };
              }>(ACTIVITY_PAGE_QUERY, {
                userId,
                page,
                types: activityTypes,
                sort: [sortDir],
              });

              if (signal.aborted) return;

              ingestActivities(pageData.Page.activities, order);
              refreshSnapshotAndRender();

              if (resolvedIds.size >= candidates.size) {
                ctx.log.debug(
                  "All candidates resolved; stopping early at page",
                  page,
                );
                break;
              }

              hasNextPage = pageData.Page.pageInfo.hasNextPage;
              page += 1;

              if (pauseRequested) {
                await waitIfPaused(signal);
              } else if (hasNextPage) {
                await sleepInterruptible(delayMs, signal);
                if (pauseRequested) {
                  await waitIfPaused(signal);
                }
              }
            }
          }

          if (signal.aborted) return;

          setScanState("done");
          setProgress(100, "idle");
          refreshSnapshotAndRender();
          setStatusIndicator(
            "done",
            `${modeLabel(mode)} complete: ${proposals.length} found, ${unresolved.length} without matching logs.`,
          );
        } catch (err) {
          if ((err as Error)?.name === "AbortError") return;
          ctx.log.error("Scan failed:", err);
          setScanState("done");
          setProgress(0, "idle");
          setStatusIndicator(
            "idle",
            `Error: ${(err as Error)?.message ?? String(err)}`,
          );
          ctx.toast.error("Date backfill scan failed.");
        }
      }

      function renderResults() {
        const resultsEl = ensureResultsScaffold();
        const prevScroll = bodyEl.scrollTop;

        const isSearching = scanState === "scanning" || scanState === "paused";
        const query = filterQuery.trim().toLowerCase();

        const filteredProposals = query
          ? proposals.filter((p) =>
              p.entry.title.toLowerCase().includes(query),
            )
          : proposals;

        const filteredUnresolved = query
          ? unresolved.filter((u) =>
              u.entry.title.toLowerCase().includes(query),
            )
          : unresolved;

        const hasAssumed = proposals.some((p) => isAssumedProposal(p));
        const selectedCount = proposals.filter((p) => p.selected).length;

        const statsHtml = `
          <div class="ala-dbf-stats">
            <div class="ala-dbf-stat-card">
              <span class="ala-dbf-stat-label">Found Entries</span>
              <span class="ala-dbf-stat-val green">${proposals.length} <span style="font-size:1.15rem;font-weight:500;color:rgb(var(--color-text-lighter));">(${selectedCount} selected)</span></span>
            </div>
            <div class="ala-dbf-stat-card">
              <span class="ala-dbf-stat-label">${isSearching ? "Not Yet Found" : "Not Found"}</span>
              <span class="ala-dbf-stat-val">${unresolved.length}</span>
            </div>
            <div class="ala-dbf-stat-card">
              <span class="ala-dbf-stat-label">Applied</span>
              <span class="ala-dbf-stat-val blue">${appliedCount}</span>
            </div>
            <div class="ala-dbf-stat-card">
              <span class="ala-dbf-stat-label">Scan Mode</span>
              <span class="ala-dbf-stat-val" style="font-size:1.35rem;">${modeLabel(activeMode)}</span>
            </div>
          </div>
        `;

        let foundSectionHtml = "";
        if (filteredProposals.length > 0) {
          const allSelected = proposals.every((p) => p.selected);
          const confirmedOnlyBtn = hasAssumed
            ? `<button type="button" class="ala-dbf-btn secondary mini" data-act="select-confirmed" title="Select only entries backed by activity logs">Confirmed Only</button>`
            : "";

          const rows = filteredProposals
            .map((p) => {
              const assumed = isAssumedProposal(p);
              const mediaUrl = `/${p.entry.mediaType.toLowerCase()}/${p.entry.mediaId}`;
              const typeClass =
                p.entry.mediaType === "MANGA"
                  ? "ala-dbf-type-badge manga"
                  : "ala-dbf-type-badge";

              const startCell = p.newStartedAt
                ? `<div>
                    <div class="ala-dbf-date-diff">
                      <span class="ala-dbf-old-date">${formatFuzzyDate(p.entry.startedAt)}</span>
                      <span class="ala-dbf-arrow">→</span>
                      <span class="ala-dbf-new-date ${assumed ? "assumed" : ""}">${formatFuzzyDate(p.newStartedAt)}</span>
                    </div>
                    <div class="ala-dbf-source ${assumed ? "assumed" : ""}">${escapeHtml(p.startSource ?? "")}</div>
                  </div>`
                : `<span class="ala-dbf-old-date">${formatFuzzyDate(p.entry.startedAt)}</span>`;

              const finishCell = p.newCompletedAt
                ? `<div class="ala-dbf-date-diff">
                    <span class="ala-dbf-old-date">${formatFuzzyDate(p.entry.completedAt)}</span>
                    <span class="ala-dbf-arrow">→</span>
                    <span class="ala-dbf-new-date">${formatFuzzyDate(p.newCompletedAt)}</span>
                  </div>`
                : `<span class="ala-dbf-old-date">${formatFuzzyDate(p.entry.completedAt)}</span>`;

              return `
                <tr class="${p.selected ? "is-selected" : "is-unselected"}">
                  <td class="ala-dbf-check-cell"><input type="checkbox" data-media-id="${p.entry.mediaId}" ${p.selected ? "checked" : ""} /></td>
                  <td class="ala-dbf-title-cell">
                    <a class="ala-dbf-media-link" href="${mediaUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.entry.title)}</a>
                    <span class="${typeClass}">${p.entry.mediaType}</span>
                  </td>
                  <td data-label="Start">${startCell}</td>
                  <td data-label="Finish">${finishCell}</td>
                </tr>
              `;
            })
            .join("");

          foundSectionHtml = `
            <div class="ala-dbf-section">
              <div class="ala-dbf-section-head">
                <span>Found Entries (${filteredProposals.length}${query ? ` of ${proposals.length}` : ""})</span>
                <div class="ala-dbf-actions">
                  ${confirmedOnlyBtn}
                  <button type="button" class="ala-dbf-btn secondary mini" data-act="toggle-all">
                    ${allSelected ? "Unselect All" : "Select All"}
                  </button>
                </div>
              </div>
              <div class="ala-dbf-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style="width:38px;"></th>
                      <th>Title</th>
                      <th style="width:225px;">Start Date</th>
                      <th style="width:185px;">Finish Date</th>
                    </tr>
                  </thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>
            </div>
          `;
        } else {
          foundSectionHtml = `
            <div class="ala-dbf-section">
              <div class="ala-dbf-section-head">
                <span>Found Entries (0)</span>
              </div>
              <p class="ala-dbf-empty-note">${
                query
                  ? "No found entries match your title filter."
                  : isSearching
                    ? "No dates matched yet — still scanning activity pages..."
                    : "No matching activity history was found for the remaining entries."
              }</p>
            </div>
          `;
        }

        let unresolvedSectionHtml = "";
        if (filteredUnresolved.length > 0) {
          const unresolvedHeading = isSearching
            ? `Not Yet Found (${filteredUnresolved.length}${query ? ` of ${unresolved.length}` : ""})`
            : `No Matching Activity Found (${filteredUnresolved.length}${query ? ` of ${unresolved.length}` : ""})`;

          const uRows = filteredUnresolved
            .map((u) => {
              const mediaUrl = `/${u.entry.mediaType.toLowerCase()}/${u.entry.mediaId}`;
              const typeClass =
                u.entry.mediaType === "MANGA"
                  ? "ala-dbf-type-badge manga"
                  : "ala-dbf-type-badge";
              const statusNote = u.ruledOutReason
                ? escapeHtml(u.ruledOutReason)
                : isSearching
                  ? "Still scanning..."
                  : "No matching activity in history";

              return `
                <tr>
                  <td class="ala-dbf-unresolved-title">
                    <a class="ala-dbf-media-link" href="${mediaUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(u.entry.title)}</a>
                    <span class="${typeClass}">${u.entry.mediaType}</span>
                  </td>
                  <td class="ala-dbf-unresolved-meta" data-label="Status"><span class="ala-dbf-pill">${escapeHtml(u.entry.status)}</span></td>
                  <td class="ala-dbf-unresolved-meta" data-label="Missing">${escapeHtml(u.missingLabel)}</td>
                  <td class="ala-dbf-unresolved-meta" data-label="Scan" style="color:rgb(var(--color-text-lighter));font-size:1.15rem;">${statusNote}</td>
                </tr>
              `;
            })
            .join("");

          const tableBody = unresolvedCollapsed
            ? ""
            : `<div class="ala-dbf-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th style="width:120px;">List Status</th>
                      <th style="width:120px;">Missing</th>
                      <th style="width:210px;">Scan Status</th>
                    </tr>
                  </thead>
                  <tbody>${uRows}</tbody>
                </table>
              </div>`;

          unresolvedSectionHtml = `
            <div class="ala-dbf-section">
              <div class="ala-dbf-section-head collapsible" data-act="toggle-unresolved">
                <span>${unresolvedHeading}</span>
                <span style="font-size:1.15rem;font-weight:600;color:rgb(var(--color-text-lighter));">
                  ${unresolvedCollapsed ? "▸ Show" : "▾ Hide"}
                </span>
              </div>
              ${tableBody}
            </div>
          `;
        }

        resultsEl.innerHTML = statsHtml + foundSectionHtml + unresolvedSectionHtml;
        bodyEl.scrollTop = prevScroll;
      }

      async function runApply() {
        const chosen = proposals.filter((p) => p.selected);
        if (chosen.length === 0) return;

        const previousState = scanState;
        primaryActionBtn.disabled = true;
        applyBtn.disabled = true;
        const backBtn = bodyEl.querySelector(
          '[data-act="back-idle"]',
        ) as HTMLButtonElement | null;
        if (backBtn) backBtn.disabled = true;

        const delayMs = ctx.get<number>("dateBackfillDelayMs");
        const signal = modalAbort.signal;

        let saved = 0;
        try {
          for (const item of chosen) {
            if (signal.aborted) return;
            setProgress(
              Math.round((saved / chosen.length) * 100),
              "applying",
            );
            setStatusIndicator(
              "active",
              `Updating ${saved + 1}/${chosen.length}: ${item.entry.title}...${formatRateLimitHint()}`,
            );

            const vars: Record<string, unknown> = { id: item.entry.entryId };
            if (item.newStartedAt) vars.startedAt = item.newStartedAt;
            if (item.newCompletedAt) vars.completedAt = item.newCompletedAt;

            await ctx.api.query(SAVE_ENTRY_MUTATION, vars);

            candidates.delete(item.entry.mediaId);
            activitiesByMedia.delete(item.entry.mediaId);
            noEarlierLogsIds.delete(item.entry.mediaId);
            selectionState.delete(item.entry.mediaId);
            saved += 1;
            appliedCount += 1;

            if (saved < chosen.length) {
              await sleepInterruptible(delayMs, signal);
            }
          }

          setProgress(100, "applying");
          refreshSnapshotAndRender();
          if (previousState === "paused") {
            setStatusIndicator(
              "paused",
              `Applied ${saved} updates (scan still paused — click Resume Scan to continue).`,
            );
          } else {
            setStatusIndicator("done", `Done! Updated ${saved} entries.`);
          }
          ctx.toast.success(`Updated dates on ${saved} AniList entries.`);
        } catch (err) {
          if ((err as Error)?.name === "AbortError") return;
          ctx.log.error("Update failed:", err);
          setProgress(0, "idle");
          refreshSnapshotAndRender();
          setStatusIndicator(
            "idle",
            `Stopped after ${saved}/${chosen.length}: ${(err as Error)?.message ?? String(err)}`,
          );
          ctx.toast.error("Failed while saving updates.");
        } finally {
          setScanState(previousState);
          const refreshedBackBtn = bodyEl.querySelector(
            '[data-act="back-idle"]',
          ) as HTMLButtonElement | null;
          if (refreshedBackBtn) {
            refreshedBackBtn.disabled = previousState === "scanning";
          }
        }
      }
    }

    ctx.menuCommand("Backfill Missing Media Dates", () => openModal());
  },
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}