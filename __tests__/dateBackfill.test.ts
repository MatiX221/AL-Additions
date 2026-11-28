import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  assumeStartFromFinish,
  buildScanSnapshot,
  chunkIds,
  compareFuzzyDatesCompatible,
  inferDatesFromActivities,
  isFirstProgress,
  type ListEntryCandidate,
  type ActivityRecord,
} from "../src/modules/dateBackfill";
import { AniList, anilistApiClient } from "../src/api/anilist";
import {
  bootModuleForTest,
  configureCoreServices,
  disposeFeature,
} from "../src/core/registry";
import * as toastModule from "../src/core/toast";
import { Settings } from "../src/settings/settings";

const makeEntry = (
  overrides: Partial<ListEntryCandidate> = {},
): ListEntryCandidate => ({
  entryId: 100,
  mediaId: 16498,
  mediaType: "ANIME",
  title: "Attack on Titan",
  status: "COMPLETED",
  repeat: 0,
  startedAt: { year: null, month: null, day: null },
  completedAt: { year: null, month: null, day: null },
  ...overrides,
});

const ts = (isoDate: string) =>
  Math.floor(new Date(`${isoDate}T12:00:00Z`).getTime() / 1000);

describe("dateBackfill inference & batching", () => {
  it("chunks media IDs cleanly for targeted mediaId_in queries", () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkIds([], 10)).toEqual([]);
  });

  it("matches ep 1 and ep 1-3 without false-matching ep 10", () => {
    expect(isFirstProgress("1")).toBe(true);
    expect(isFirstProgress("1 - 3")).toBe(true);
    expect(isFirstProgress("10")).toBe(false);
    expect(isFirstProgress("2 - 12")).toBe(false);
  });

  it("falls back to earliest episode 2+ when episode 1 was never logged", () => {
    const entry = makeEntry();
    const activities: ActivityRecord[] = [
      { id: 3, mediaId: 16498, status: "completed", progress: null, createdAt: ts("2018-04-20") },
      { id: 2, mediaId: 16498, status: "watched episode", progress: "4 - 12", createdAt: ts("2018-04-15") },
      { id: 1, mediaId: 16498, status: "watched episode", progress: "2 - 3", createdAt: ts("2018-04-10") },
    ];

    const res = inferDatesFromActivities(entry, activities, false);
    expect(res?.newStartedAt).toEqual({ year: 2018, month: 4, day: 10 });
    expect(res?.newCompletedAt).toEqual({ year: 2018, month: 4, day: 20 });
    expect(res?.startSource).toBe("watched episode 2 - 3");
  });

  it("assumes startDate = completedAt (unchecked) when no earlier logs exist", () => {
    const passedFinishEntry = makeEntry({
      mediaId: 1,
      entryId: 10,
      title: "Passed Finish Show",
      completedAt: { year: 2018, month: 6, day: 15 },
    });
    const noLogsAtAllEntry = makeEntry({
      mediaId: 2,
      entryId: 20,
      title: "Silent Complete Show",
      completedAt: { year: 2017, month: 11, day: 3 },
    });
    const bothMissingEntry = makeEntry({
      mediaId: 3,
      entryId: 30,
      title: "Both Missing Show",
    });

    const candidates = new Map<number, ListEntryCandidate>([
      [1, passedFinishEntry],
      [2, noLogsAtAllEntry],
      [3, bothMissingEntry],
    ]);

    const midScan = buildScanSnapshot(
      candidates,
      new Map(),
      new Map(),
      new Set([1]),
      false,
      false,
      new Map(),
    );
    expect(midScan.proposals).toHaveLength(1);
    expect(midScan.proposals[0].entry.title).toBe("Passed Finish Show");
    expect(midScan.proposals[0].newStartedAt).toEqual({ year: 2018, month: 6, day: 15 });
    expect(midScan.proposals[0].selected).toBe(false);
    expect(midScan.unresolved).toHaveLength(2);

    const endScan = buildScanSnapshot(
      candidates,
      new Map(),
      new Map(),
      new Set([1]),
      true,
      false,
      new Map(),
    );
    expect(endScan.proposals).toHaveLength(2);
    expect(endScan.proposals[1].entry.title).toBe("Silent Complete Show");
    expect(endScan.proposals[1].newStartedAt).toEqual({ year: 2017, month: 11, day: 3 });
    expect(endScan.proposals[1].selected).toBe(false);
    expect(endScan.unresolved).toHaveLength(1);
    expect(endScan.unresolved[0].entry.title).toBe("Both Missing Show");
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

describe("BUG-69: precision-aware FuzzyDate compatibility", () => {
  it("compares partial year-only and year+month dates at the coarsest shared precision", () => {
    expect(
      compareFuzzyDatesCompatible(
        { year: 2022, month: 3, day: 15 },
        { year: 2022, month: null, day: null },
      ),
    ).toBe(0);
    expect(
      compareFuzzyDatesCompatible(
        { year: 2023, month: 1, day: 1 },
        { year: 2022, month: null, day: null },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareFuzzyDatesCompatible(
        { year: 2021, month: 12, day: 31 },
        { year: 2022, month: null, day: null },
      ),
    ).toBeLessThan(0);

    expect(
      compareFuzzyDatesCompatible(
        { year: 2022, month: 3, day: 25 },
        { year: 2022, month: 3, day: null },
      ),
    ).toBe(0);
    expect(
      compareFuzzyDatesCompatible(
        { year: 2022, month: 4, day: 1 },
        { year: 2022, month: 3, day: null },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareFuzzyDatesCompatible(
        { year: 2022, month: 2, day: 28 },
        { year: 2022, month: 3, day: null },
      ),
    ).toBeLessThan(0);
  });

  it("matches activities within partial year-only and year+month completedAt bounds", () => {
    const yearOnlyEntry = makeEntry({
      completedAt: { year: 2022, month: null, day: null },
    });
    const sameYearActs: ActivityRecord[] = [
      { id: 1, mediaId: 16498, status: "watched episode", progress: "1", createdAt: ts("2022-03-15") },
    ];
    const nextYearActs: ActivityRecord[] = [
      { id: 2, mediaId: 16498, status: "watched episode", progress: "1", createdAt: ts("2023-01-05") },
    ];

    expect(inferDatesFromActivities(yearOnlyEntry, sameYearActs, false)?.newStartedAt).toEqual({
      year: 2022,
      month: 3,
      day: 15,
    });
    expect(inferDatesFromActivities(yearOnlyEntry, sameYearActs, true)?.newStartedAt).toEqual({
      year: 2022,
      month: 3,
      day: 15,
    });
    expect(inferDatesFromActivities(yearOnlyEntry, nextYearActs, false)).toBeNull();

    const yearMonthEntry = makeEntry({
      completedAt: { year: 2022, month: 3, day: null },
    });
    const sameMonthActs: ActivityRecord[] = [
      { id: 3, mediaId: 16498, status: "watched episode", progress: "1", createdAt: ts("2022-03-25") },
    ];
    const nextMonthActs: ActivityRecord[] = [
      { id: 4, mediaId: 16498, status: "watched episode", progress: "1", createdAt: ts("2022-04-01") },
    ];

    expect(inferDatesFromActivities(yearMonthEntry, sameMonthActs, false)?.newStartedAt).toEqual({
      year: 2022,
      month: 3,
      day: 25,
    });
    expect(inferDatesFromActivities(yearMonthEntry, nextMonthActs, false)).toBeNull();
  });

  it("keeps assumeStartFromFinish single-day check strict on complete dates", () => {
    const entry = makeEntry({
      startedAt: { year: 2022, month: 3, day: null },
      completedAt: { year: 2022, month: 3, day: 15 },
    });

    const assumed = assumeStartFromFinish(entry, true);
    expect(assumed?.newStartedAt).toEqual({ year: 2022, month: 3, day: 15 });
  });
});

describe("dateBackfill modal lifecycle, abort guards & ASC ingestion (BUG-69, BUG-70, BUG-71)", () => {
  const menuHandlers = new Map<string, () => void>();
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockGetMediaList: ReturnType<typeof vi.fn>;
  let mockViewer: ReturnType<typeof vi.fn>;
  let mockSession: any;

  beforeAll(() => {
    vi.mocked(globalThis.GM_registerMenuCommand).mockImplementation(
      (label: string, cb: () => void) => {
        menuHandlers.set(label, cb);
      },
    );
  });

  beforeEach(async () => {
    Settings.set("dateBackfillScope", "ANIME");
    Settings.set("dateBackfillOrder", "ASC");
    Settings.set("dateBackfillPartial", false);
    Settings.set("dateBackfillDelayMs", 0);

    mockQuery = vi.fn();
    mockGetMediaList = vi.fn();
    mockViewer = vi.fn();
    mockSession = {
      peek: () => ({ userId: 42, username: "Tester", scoreFormat: "POINT_10" }),
      userId: 42,
      username: "Tester",
      scoreFormat: "POINT_10",
      hasAuth: () => true,
      clear: vi.fn(),
      syncFromPage: vi.fn(),
      recordHint: vi.fn(),
    };

    configureCoreServices({
      api: {
        query: mockQuery,
        getMediaList: mockGetMediaList,
        viewer: mockViewer,
        clearViewer: vi.fn(),
        invalidate: vi.fn(),
        invalidateMediaList: vi.fn(),
        hasAuth: () => true,
        resumeAt: () => 0,
        media: { get: vi.fn(), save: vi.fn() },
        session: mockSession,
      } as any,
      session: mockSession,
    });

    await bootModuleForTest("dateBackfill");
  });

  afterEach(() => {
    disposeFeature("dateBackfill");
    configureCoreServices({
      api: anilistApiClient,
      session: AniList.session,
    });
    vi.restoreAllMocks();
  });

  function openBackfillModal(): HTMLElement {
    const open = menuHandlers.get("Backfill Missing Media Dates");
    expect(open).toBeTypeOf("function");
    open!();
    const backdrop = document.getElementById("ala-dateBackfill-modal");
    expect(backdrop).not.toBeNull();
    return backdrop!;
  }

  it("BUG-69: ASC ingestActivities accepts compatible logs for year-only and year+month completedAt while rejecting later months", async () => {
    mockGetMediaList.mockResolvedValue({
      allEntries: [
        {
          id: 101,
          mediaId: 1001,
          status: "COMPLETED",
          repeat: 0,
          startedAt: { year: null, month: null, day: null },
          completedAt: { year: 2022, month: null, day: null },
          media: { title: { userPreferred: "Year Only Show" } },
        },
        {
          id: 102,
          mediaId: 1002,
          status: "COMPLETED",
          repeat: 0,
          startedAt: { year: null, month: null, day: null },
          completedAt: { year: 2022, month: 3, day: null },
          media: { title: { userPreferred: "Year Month Show" } },
        },
        {
          id: 103,
          mediaId: 1003,
          status: "COMPLETED",
          repeat: 0,
          startedAt: { year: null, month: null, day: null },
          completedAt: { year: 2022, month: 3, day: null },
          media: { title: { userPreferred: "Too Late Show" } },
        },
      ],
    });

    mockQuery.mockResolvedValue({
      Page: {
        pageInfo: { hasNextPage: false, lastPage: 1 },
        activities: [
          {
            id: 5001,
            status: "watched episode",
            progress: "1",
            createdAt: ts("2022-03-15"),
            media: { id: 1001 },
          },
          {
            id: 5002,
            status: "watched episode",
            progress: "1",
            createdAt: ts("2022-03-20"),
            media: { id: 1002 },
          },
          {
            id: 5003,
            status: "watched episode",
            progress: "1",
            createdAt: ts("2022-04-01"),
            media: { id: 1003 },
          },
        ],
      },
    });

    const backdrop = openBackfillModal();
    backdrop.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!.click();
    await flushMicrotasks(12);

    const text = backdrop.textContent ?? "";
    expect(text).toContain("Year Only Show");
    expect(text).toContain("2022-03-15");
    expect(text).toContain("Year Month Show");
    expect(text).toContain("2022-03-20");
    expect(text).toContain("Too Late Show");
    expect(text).not.toContain("2022-04-01");
    expect(text).toContain("assumed from finish date (no earlier log)");
    expect(backdrop.querySelector('[data-act="apply"]')?.textContent).toBe("Apply Selected (2)");
  });

  it("BUG-70: suppresses toasts and DOM updates when modal is closed mid-mutation (resolve & reject)", async () => {
    const toastSuccessSpy = vi.spyOn(toastModule, "toastSuccess");
    const toastErrorSpy = vi.spyOn(toastModule, "toastError");
    const showToastSpy = vi.spyOn(toastModule, "showToast");

    const setupSingleEntryScan = async () => {
      mockGetMediaList.mockResolvedValue({
        allEntries: [
          {
            id: 201,
            mediaId: 2001,
            status: "COMPLETED",
            repeat: 0,
            startedAt: { year: null, month: null, day: null },
            completedAt: { year: 2022, month: 5, day: 10 },
            media: { title: { userPreferred: "Apply Target" } },
          },
        ],
      });

      mockQuery.mockResolvedValueOnce({
        Page: {
          pageInfo: { hasNextPage: false, lastPage: 1 },
          activities: [
            {
              id: 6001,
              status: "watched episode",
              progress: "1",
              createdAt: ts("2022-05-01"),
              media: { id: 2001 },
            },
          ],
        },
      });
    };

    await setupSingleEntryScan();
    const backdrop1 = openBackfillModal();
    backdrop1.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!.click();
    await flushMicrotasks(12);

    const applyDeferred1 = deferred<any>();
    mockQuery.mockReturnValueOnce(applyDeferred1.promise);
    backdrop1.querySelector<HTMLButtonElement>('[data-act="apply"]')!.click();
    await flushMicrotasks(2);

    backdrop1.querySelector<HTMLButtonElement>(".ala-core-close")!.click();
    applyDeferred1.resolve({ SaveMediaListEntry: { id: 201 } });
    await flushMicrotasks(10);

    expect(toastSuccessSpy).not.toHaveBeenCalled();
    expect(toastErrorSpy).not.toHaveBeenCalled();
    expect(showToastSpy).not.toHaveBeenCalled();

    await setupSingleEntryScan();
    const backdrop2 = openBackfillModal();
    backdrop2.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!.click();
    await flushMicrotasks(12);

    const applyDeferred2 = deferred<any>();
    mockQuery.mockReturnValueOnce(applyDeferred2.promise);
    backdrop2.querySelector<HTMLButtonElement>('[data-act="apply"]')!.click();
    await flushMicrotasks(2);

    backdrop2.querySelector<HTMLButtonElement>(".ala-core-close")!.click();
    applyDeferred2.reject(new Error("Network failure"));
    await flushMicrotasks(10);

    expect(toastSuccessSpy).not.toHaveBeenCalled();
    expect(toastErrorSpy).not.toHaveBeenCalled();
    expect(showToastSpy).not.toHaveBeenCalled();
  });

  it("BUG-71: scopes overlay listeners to modal lifecycle instead of module ctx cleanups", () => {
    const origAddEventListener = HTMLDivElement.prototype.addEventListener;
    const capturedOverlayTypes: string[] = [];
    vi.spyOn(HTMLDivElement.prototype, "addEventListener").mockImplementation(function (
      this: HTMLDivElement,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (this.id === "ala-dateBackfill-modal" && (type === "click" || type === "input" || type === "change")) {
        capturedOverlayTypes.push(type);
      }
      return origAddEventListener.call(this, type, listener, options);
    });

    const backdrop = openBackfillModal();
    expect(capturedOverlayTypes.filter((t) => t !== "click")).toEqual(["input", "change"]);
    expect(capturedOverlayTypes.filter((t) => t === "click").length).toBe(2);

    const removeListenerSpy = vi.spyOn(backdrop, "removeEventListener");
    backdrop.querySelector<HTMLButtonElement>(".ala-core-close")!.click();
    expect(removeListenerSpy.mock.calls.map((c) => c[0]).sort()).toEqual([
      "change",
      "click",
      "input",
    ]);

    backdrop
      .querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockGetMediaList).not.toHaveBeenCalled();
    expect(mockViewer).not.toHaveBeenCalled();

    removeListenerSpy.mockClear();
    disposeFeature("dateBackfill");
    expect(removeListenerSpy).not.toHaveBeenCalled();
  });

  it("BUG-71: guards runScan synchronously before resolveUserId() and rolls back on failure/missing auth", async () => {
    const toastErrorSpy = vi.spyOn(toastModule, "toastError");
    mockSession.userId = null;

    const viewerDeferred1 = deferred<{ id: number } | null>();
    mockViewer.mockReturnValueOnce(viewerDeferred1.promise);

    const backdrop = openBackfillModal();
    const fastBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!;
    const fullBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="scan-full"]')!;

    fastBtn.click();
    expect(fastBtn.disabled).toBe(true);
    expect(fullBtn.disabled).toBe(true);

    fullBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    fastBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockViewer).toHaveBeenCalledTimes(1);

    viewerDeferred1.resolve(null);
    await flushMicrotasks(8);

    expect(toastErrorSpy).toHaveBeenCalledWith(
      "Please log in to AniList first.",
      undefined,
    );
    expect(fastBtn.disabled).toBe(false);
    expect(fullBtn.disabled).toBe(false);

    const viewerDeferred2 = deferred<{ id: number } | null>();
    mockViewer.mockReturnValueOnce(viewerDeferred2.promise);
    mockGetMediaList.mockResolvedValue({ allEntries: [] });

    fullBtn.click();
    expect(fastBtn.disabled).toBe(true);
    expect(fullBtn.disabled).toBe(true);
    expect(mockViewer).toHaveBeenCalledTimes(2);

    viewerDeferred2.resolve({ id: 42 });
    await flushMicrotasks(10);

    expect(mockGetMediaList).toHaveBeenCalledWith(42, "ANIME", { signal: expect.any(AbortSignal) });
    expect(backdrop.textContent).toContain("All checked list entries already have dates set!");
  });

  it("IMP-10: escapes HTML special characters including single quotes via shared esc helper", async () => {
    const xssTitle = `O'Neill's <img src=x onerror=alert(1)> & "Quote"`;
    mockGetMediaList.mockResolvedValue({
      allEntries: [
        {
          id: 301,
          mediaId: 3001,
          status: "COMPLETED",
          repeat: 0,
          startedAt: { year: null, month: null, day: null },
          completedAt: { year: 2023, month: 1, day: 10 },
          media: { title: { userPreferred: xssTitle } },
        },
        {
          id: 302,
          mediaId: 3002,
          status: "CURRENT",
          repeat: 0,
          startedAt: { year: null, month: null, day: null },
          completedAt: { year: null, month: null, day: null },
          media: { title: { userPreferred: `Unresolved <svg onload='alert(1)'>` } },
        },
      ],
    });

    mockQuery.mockResolvedValue({
      Page: {
        pageInfo: { hasNextPage: false, lastPage: 1 },
        activities: [
          {
            id: 7001,
            status: "watched episode",
            progress: "1",
            createdAt: ts("2023-01-05"),
            media: { id: 3001 },
          },
        ],
      },
    });

    const backdrop = openBackfillModal();
    backdrop.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!.click();
    await flushMicrotasks(12);

    expect(backdrop.querySelectorAll("img")).toHaveLength(0);
    expect(backdrop.querySelectorAll("svg")).toHaveLength(0);
    const links = Array.from(backdrop.querySelectorAll<HTMLAnchorElement>(".ala-dbf-media-link"));
    expect(links.map((a) => a.textContent)).toEqual([
      xssTitle,
      `Unresolved <svg onload='alert(1)'>`,
    ]);
    expect(backdrop.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(backdrop.innerHTML).toContain("&lt;svg onload=");
  });

  it("BUG-43: locks selection controls, primary action, back button, and concurrent apply/scan/reset while runApply is in flight", async () => {
    const toastSuccessSpy = vi.spyOn(toastModule, "toastSuccess");
    const toastErrorSpy = vi.spyOn(toastModule, "toastError");

    mockGetMediaList.mockResolvedValue({
      allEntries: [
        {
          id: 401,
          mediaId: 4001,
          status: "COMPLETED",
          repeat: 0,
          startedAt: { year: null, month: null, day: null },
          completedAt: { year: 2023, month: 2, day: 10 },
          media: { title: { userPreferred: "Confirmed Show" } },
        },
        {
          id: 402,
          mediaId: 4002,
          status: "COMPLETED",
          repeat: 0,
          startedAt: { year: null, month: null, day: null },
          completedAt: { year: 2023, month: 2, day: 12 },
          media: { title: { userPreferred: "Assumed Show" } },
        },
      ],
    });

    mockQuery.mockResolvedValueOnce({
      Page: {
        pageInfo: { hasNextPage: false, lastPage: 1 },
        activities: [
          {
            id: 8001,
            status: "watched episode",
            progress: "1",
            createdAt: ts("2023-02-01"),
            media: { id: 4001 },
          },
        ],
      },
    });

    const backdrop = openBackfillModal();
    backdrop.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!.click();
    await flushMicrotasks(12);

    const applyBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="apply"]')!;
    const primaryBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="primary-action"]')!;
    const backBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="back-idle"]')!;
    const toggleAllBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="toggle-all"]')!;
    const selectConfirmedBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="select-confirmed"]')!;
    const checkboxes = Array.from(
      backdrop.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-media-id]'),
    );

    expect(checkboxes).toHaveLength(2);
    expect(applyBtn.disabled).toBe(false);
    expect(primaryBtn.disabled).toBe(false);
    expect(backBtn.disabled).toBe(false);

    const applyDeferred = deferred<any>();
    mockQuery.mockReturnValueOnce(applyDeferred.promise);

    applyBtn.click();
    await flushMicrotasks(2);

    // Every action and selection control must be disabled mid-apply
    expect(applyBtn.disabled).toBe(true);
    expect(primaryBtn.disabled).toBe(true);
    expect(backBtn.disabled).toBe(true);
    expect(toggleAllBtn.disabled).toBe(true);
    expect(selectConfirmedBtn.disabled).toBe(true);
    expect(checkboxes.every((cb) => cb.disabled)).toBe(true);

    // Synthetic checkbox/bulk-select/action events mid-apply must not re-enable buttons or launch overlapping work
    checkboxes[1].checked = true;
    checkboxes[1].dispatchEvent(new Event("change", { bubbles: true }));
    toggleAllBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    selectConfirmedBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    applyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    primaryBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    backBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushMicrotasks(4);

    expect(applyBtn.disabled).toBe(true);
    expect(primaryBtn.disabled).toBe(true);
    expect(backBtn.disabled).toBe(true);
    expect(toggleAllBtn.disabled).toBe(true);
    expect(selectConfirmedBtn.disabled).toBe(true);
    expect(checkboxes.every((cb) => cb.disabled)).toBe(true);
    // 1 activity query + 1 in-flight SaveMediaListEntry mutation only
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(backdrop.querySelector('[data-role="results"]')).not.toBeNull();

    // Finish apply and verify controls unlock cleanly via finally
    applyDeferred.resolve({ SaveMediaListEntry: { id: 401 } });
    await flushMicrotasks(10);

    expect(toastSuccessSpy).toHaveBeenCalledWith(
      "Updated dates on 1 AniList entries.",
      undefined,
    );
    expect(toastErrorSpy).not.toHaveBeenCalled();

    const postPrimaryBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="primary-action"]')!;
    const postBackBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="back-idle"]')!;
    const postToggleAllBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="toggle-all"]')!;
    const remainingCb = backdrop.querySelector<HTMLInputElement>('input[type="checkbox"][data-media-id="4002"]')!;

    expect(postPrimaryBtn.disabled).toBe(false);
    expect(postBackBtn.disabled).toBe(false);
    expect(postToggleAllBtn.disabled).toBe(false);
    expect(remainingCb.disabled).toBe(false);
    expect(applyBtn.disabled).toBe(true); // 0 selected left

    // Selecting the remaining assumed entry re-enables Apply Selected after apply finishes
    remainingCb.checked = true;
    remainingCb.dispatchEvent(new Event("change", { bubbles: true }));
    expect(applyBtn.disabled).toBe(false);

    // Non-abort rejection also unlocks isApplying cleanly in finally
    mockQuery.mockRejectedValueOnce(new Error("Save failed"));
    applyBtn.click();
    await flushMicrotasks(10);

    expect(toastErrorSpy).toHaveBeenCalledWith(
      "Failed while saving updates.",
      undefined,
    );
    expect(postPrimaryBtn.disabled).toBe(false);
    expect(postBackBtn.disabled).toBe(false);
    expect(backdrop.querySelector<HTMLButtonElement>('[data-act="toggle-all"]')!.disabled).toBe(false);
    expect(backdrop.querySelector<HTMLInputElement>('input[type="checkbox"][data-media-id="4002"]')!.disabled).toBe(false);
    expect(applyBtn.disabled).toBe(false);
  });

  it("BUG-44: forwards modal.signal and scanAbort.signal to ctx.api calls and handles HttpClient aborts cleanly", async () => {
    const toastErrorSpy = vi.spyOn(toastModule, "toastError");

    // 1. resolveUserId passes modal.signal to viewer() and handles AbortError on modal close
    mockSession.userId = null;
    const viewerDeferred = deferred<{ id: number } | null>();
    mockViewer.mockReturnValueOnce(viewerDeferred.promise);

    const backdrop1 = openBackfillModal();
    backdrop1.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!.click();
    expect(mockViewer).toHaveBeenCalledWith(false, { signal: expect.any(AbortSignal) });
    const viewerSignal = mockViewer.mock.calls[0][1].signal as AbortSignal;
    expect(viewerSignal.aborted).toBe(false);

    backdrop1.querySelector<HTMLButtonElement>(".ala-core-close")!.click();
    expect(viewerSignal.aborted).toBe(true);
    viewerDeferred.reject(new Error("Request aborted"));
    await flushMicrotasks(8);
    expect(toastErrorSpy).not.toHaveBeenCalled();

    // 2. Targeted scan passes scanAbort.signal to getMediaList + ACTIVITY_PAGE_QUERY, aborted by ← Modes without closing modal
    mockSession.userId = 42;
    mockGetMediaList.mockResolvedValue({
      allEntries: [
        {
          id: 501,
          mediaId: 5001,
          status: "COMPLETED",
          repeat: 0,
          startedAt: { year: null, month: null, day: null },
          completedAt: { year: 2023, month: 3, day: 1 },
          media: { title: { userPreferred: "Abort Target" } },
        },
      ],
    });
    const targetedQueryDeferred = deferred<any>();
    mockQuery.mockReturnValueOnce(targetedQueryDeferred.promise);

    const backdrop2 = openBackfillModal();
    backdrop2.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!.click();
    await flushMicrotasks(8);

    expect(mockGetMediaList).toHaveBeenCalledWith(42, "ANIME", { signal: expect.any(AbortSignal) });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("Page("),
      expect.objectContaining({ userId: 42, mediaIds: [5001] }),
      { signal: expect.any(AbortSignal) },
    );

    const listSignal = mockGetMediaList.mock.calls[0][2].signal as AbortSignal;
    const scanQuerySignal = mockQuery.mock.calls[0][2].signal as AbortSignal;
    expect(listSignal.aborted).toBe(false);
    expect(scanQuerySignal.aborted).toBe(false);

    // Pause between pages so ← Modes is enabled, then click ← Modes to abort scanAbort without closing modal
    backdrop2.querySelector<HTMLButtonElement>('[data-act="primary-action"]')!.click();
    targetedQueryDeferred.resolve({
      Page: {
        pageInfo: { hasNextPage: true, lastPage: 2 },
        activities: [],
      },
    });
    await flushMicrotasks(8);
    expect(listSignal.aborted).toBe(false);
    expect(scanQuerySignal.aborted).toBe(false);

    backdrop2.querySelector<HTMLButtonElement>('[data-act="back-idle"]')!.click();
    expect(listSignal.aborted).toBe(true);
    expect(scanQuerySignal.aborted).toBe(true);
    expect(toastErrorSpy).not.toHaveBeenCalled();
    expect(backdrop2.querySelector('[data-act="scan-full"]')).not.toBeNull();

    // 3. Full Feed Scan passes scanAbort.signal and aborts cleanly on modal close
    const feedQueryDeferred = deferred<any>();
    mockQuery.mockReturnValueOnce(feedQueryDeferred.promise);
    backdrop2.querySelector<HTMLButtonElement>('[data-act="scan-full"]')!.click();
    await flushMicrotasks(8);

    const feedSignal = mockQuery.mock.calls[1][2].signal as AbortSignal;
    expect(feedSignal.aborted).toBe(false);

    backdrop2.querySelector<HTMLButtonElement>(".ala-core-close")!.click();
    expect(feedSignal.aborted).toBe(true);
    feedQueryDeferred.reject(new Error("Request aborted"));
    await flushMicrotasks(8);
    expect(toastErrorSpy).not.toHaveBeenCalled();

    // 4. runApply passes modal.signal to SAVE_ENTRY_MUTATION and handles Request aborted cleanly
    mockQuery.mockResolvedValueOnce({
      Page: {
        pageInfo: { hasNextPage: false, lastPage: 1 },
        activities: [
          {
            id: 9001,
            status: "watched episode",
            progress: "1",
            createdAt: ts("2023-02-20"),
            media: { id: 5001 },
          },
        ],
      },
    });

    const backdrop3 = openBackfillModal();
    backdrop3.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!.click();
    await flushMicrotasks(12);

    const applyDeferred = deferred<any>();
    mockQuery.mockReturnValueOnce(applyDeferred.promise);
    backdrop3.querySelector<HTMLButtonElement>('[data-act="apply"]')!.click();
    await flushMicrotasks(2);

    const mutationCall = mockQuery.mock.calls[3];
    expect(mutationCall[0]).toContain("SaveMediaListEntry");
    expect(mutationCall[1]).toEqual({
      id: 501,
      startedAt: { year: 2023, month: 2, day: 20 },
    });
    expect(mutationCall[2]).toEqual({ signal: expect.any(AbortSignal) });
    const applySignal = mutationCall[2].signal as AbortSignal;
    expect(applySignal.aborted).toBe(false);

    backdrop3.querySelector<HTMLButtonElement>(".ala-core-close")!.click();
    expect(applySignal.aborted).toBe(true);
    applyDeferred.reject(new Error("Request aborted"));
    await flushMicrotasks(8);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("IMP-04: renders heading and subtitle via ModalOptions.subtitle without manual header DOM surgery", () => {
    const backdrop = openBackfillModal();
    const headText = backdrop.querySelector(".ala-core-head-text");
    const heading = backdrop.querySelector(".ala-core-head h2");
    const subtitle = backdrop.querySelector(".ala-core-subtitle");

    expect(headText).not.toBeNull();
    expect(heading?.textContent).toBe("Missing Date Backfill");
    expect(subtitle?.textContent).toBe(
      "Recover missing start and completion dates from your AniList activity logs",
    );
    expect(headText?.contains(heading!)).toBe(true);
    expect(headText?.contains(subtitle!)).toBe(true);
    expect(backdrop.querySelector(".ala-dbf-title-wrap")).toBeNull();
    expect(backdrop.querySelector(".ala-dbf-subtitle")).toBeNull();
  });

  it("IMP-05: wakes sleepInterruptible immediately on Pause via wakeSleepFn and cancels timer on abort", async () => {
    vi.useFakeTimers();
    const toastErrorSpy = vi.spyOn(toastModule, "toastError");
    Settings.set("dateBackfillDelayMs", 5000);

    mockGetMediaList.mockResolvedValue({
      allEntries: [
        {
          id: 601,
          mediaId: 6001,
          status: "COMPLETED",
          repeat: 0,
          startedAt: { year: null, month: null, day: null },
          completedAt: { year: 2024, month: 1, day: 10 },
          media: { title: { userPreferred: "Paced Show" } },
        },
      ],
    });

    mockQuery
      .mockResolvedValueOnce({
        Page: {
          pageInfo: { hasNextPage: true, lastPage: 2 },
          activities: [],
        },
      })
      .mockResolvedValueOnce({
        Page: {
          pageInfo: { hasNextPage: false, lastPage: 2 },
          activities: [
            {
              id: 9501,
              status: "watched episode",
              progress: "1",
              createdAt: ts("2024-01-02"),
              media: { id: 6001 },
            },
          ],
        },
      });

    const backdrop = openBackfillModal();
    backdrop.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!.click();
    await flushMicrotasks(12);

    // Page 1 completed; scan is now sleeping 5000ms before page 2
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    // Clicking Pause wakes sleepInterruptible immediately without waiting 5000ms
    const primaryBtn = backdrop.querySelector<HTMLButtonElement>('[data-act="primary-action"]')!;
    expect(primaryBtn.textContent).toBe("Pause");
    primaryBtn.click();
    await flushMicrotasks(10);

    expect(vi.getTimerCount()).toBe(0);
    expect(primaryBtn.textContent).toBe("Resume Scan");
    expect(backdrop.querySelector('[data-role="status"]')?.textContent).toContain("Paused (Fast Scan)");
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Resuming fetches page 2 and completes scan
    primaryBtn.click();
    await flushMicrotasks(12);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(backdrop.querySelector('[data-role="status"]')?.textContent).toContain("Fast Scan complete");

    // Closing modal while sleepInterruptible is sleeping cancels timer immediately with no error toast
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({
      Page: {
        pageInfo: { hasNextPage: true, lastPage: 2 },
        activities: [],
      },
    });
    const backdrop2 = openBackfillModal();
    backdrop2.querySelector<HTMLButtonElement>('[data-act="scan-fast"]')!.click();
    await flushMicrotasks(12);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    backdrop2.querySelector<HTMLButtonElement>(".ala-core-close")!.click();
    await flushMicrotasks(8);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(toastErrorSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});