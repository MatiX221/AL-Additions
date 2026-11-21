import { describe, it, expect } from "vitest";
import {
  buildScanSnapshot,
  chunkIds,
  inferDatesFromActivities,
  isFirstProgress,
  type ListEntryCandidate,
  type ActivityRecord,
} from "../src/modules/dateBackfill";

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