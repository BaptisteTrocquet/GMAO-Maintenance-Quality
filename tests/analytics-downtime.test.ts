import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  assetFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: mocks.queryRaw,
    asset: { findFirst: mocks.assetFindFirst },
  },
}));

import {
  buildDowntimeDashboard,
  DowntimeAnalyticsError,
} from "@/lib/analytics/downtime";

const now = new Date("2026-08-08T10:00:00.000Z");

describe("downtime analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.queryRaw
      .mockResolvedValueOnce([
        { month: "2026-06", eventCount: 2, minutes: 90 },
        { month: "2026-07", eventCount: 1, minutes: 30 },
      ])
      .mockResolvedValueOnce([
        {
          assetId: "asset-a",
          code: "AST-001",
          name: "Synthetic asset",
          eventCount: 2,
          minutes: 75,
        },
      ]);
  });

  it("derives total, average and asset points from database aggregates", async () => {
    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-06-01",
      to: "2026-07-31",
      now,
    });

    expect(result.empty).toBe(false);
    expect(result.totalMinutes).toBe(120);
    expect(result.totalHours).toBe(2);
    expect(result.eventCount).toBe(3);
    expect(result.averageMinutesPerEvent).toBe(40);
    expect(result.trend).toEqual([
      { month: "2026-06", eventCount: 2, minutes: 90, hours: 1.5 },
      { month: "2026-07", eventCount: 1, minutes: 30, hours: 0.5 },
    ]);
    expect(result.topAssets[0]).toMatchObject({
      assetId: "asset-a",
      code: "AST-001",
      minutes: 75,
      hours: 1.25,
    });
  });

  it("uses local-calendar boundaries across the 23-hour spring DST day", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-03-29",
      to: "2026-03-29",
      now: new Date("2026-04-01T00:00:00.000Z"),
    });

    expect(result.range.from).toBe("2026-03-28T23:00:00.000Z");
    expect(result.range.toExclusive).toBe("2026-03-29T22:00:00.000Z");
    expect(
      new Date(result.range.toExclusive).getTime() - new Date(result.range.from).getTime(),
    ).toBe(23 * 60 * 60 * 1000);
  });

  it("caps the reporting window at now and returns an explicit empty result for future-only ranges", async () => {
    mocks.queryRaw.mockReset();

    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-08-10",
      to: "2026-08-20",
      now,
    });

    expect(result.empty).toBe(true);
    expect(result.totalMinutes).toBe(0);
    expect(result.averageMinutesPerEvent).toBeNull();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("validates an optional asset inside the active tenant/site scope", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(
      buildDowntimeDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "UTC",
        from: "2026-07-01",
        to: "2026-07-31",
        assetId: "asset-other",
        now,
      }),
    ).rejects.toBeInstanceOf(DowntimeAnalyticsError);

    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: {
        id: "asset-other",
        siteId: "site-a",
        archivedAt: null,
        site: { organizationId: "org-a", active: true },
      },
      select: { id: true },
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("returns zero/null semantics rather than invented downtime when no events exist", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-07-01",
      to: "2026-07-31",
      now,
    });

    expect(result).toMatchObject({
      empty: true,
      totalMinutes: 0,
      totalHours: 0,
      eventCount: 0,
      averageMinutesPerEvent: null,
      trend: [],
      topAssets: [],
    });
  });
});
