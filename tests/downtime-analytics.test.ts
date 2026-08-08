import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    asset: { findFirst: mocks.assetFindFirst },
    $queryRaw: mocks.queryRaw,
  },
}));

import {
  buildDowntimeDashboard,
  DOWNTIME_TOP_ASSET_LIMIT,
  DowntimeAnalyticsError,
} from "@/lib/analytics/downtime";

const now = new Date("2026-04-01T12:00:00.000Z");

function sqlText(callIndex: number) {
  const query = mocks.queryRaw.mock.calls[callIndex]?.[0] as
    | { sql?: string; text?: string }
    | undefined;
  return query?.sql ?? query?.text ?? "";
}

describe("downtime analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.queryRaw
      .mockResolvedValueOnce([
        { month: "2026-01", eventCount: 2, minutes: 180 },
        { month: "2026-02", eventCount: 1, minutes: 60 },
      ])
      .mockResolvedValueOnce([
        {
          assetId: "asset-a",
          code: "ASSET-001",
          name: "Synthetic asset",
          eventCount: 2,
          minutes: 180,
        },
      ]);
  });

  it("aggregates monthly downtime and derives totals without loading work-order rows", async () => {
    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-01-01",
      to: "2026-03-31",
      now,
    });

    expect(result).toMatchObject({
      empty: false,
      totalMinutes: 240,
      totalHours: 4,
      eventCount: 3,
      averageMinutesPerEvent: 80,
    });
    expect(result.trend).toEqual([
      { month: "2026-01", eventCount: 2, minutes: 180, hours: 3 },
      { month: "2026-02", eventCount: 1, minutes: 60, hours: 1 },
    ]);
    expect(result.topAssets[0]).toMatchObject({ assetId: "asset-a", hours: 3 });

    expect(sqlText(0)).toContain("TO_CHAR");
    expect(sqlText(0)).toContain("wo.status = 'COMPLETED'");
    expect(sqlText(0)).toContain('wo."downtimeMinutes" > 0');
    expect(sqlText(1)).toContain('INNER JOIN "Asset" asset');
    expect(sqlText(1)).toContain("ORDER BY minutes DESC");
    expect(DOWNTIME_TOP_ASSET_LIMIT).toBe(10);
  });

  it("uses local-calendar bounds across a 23-hour spring DST day", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-03-29",
      to: "2026-03-29",
      now,
    });

    expect(result.range.from).toBe("2026-03-28T23:00:00.000Z");
    expect(result.range.toExclusive).toBe("2026-03-29T22:00:00.000Z");
    expect(
      new Date(result.range.toExclusive).getTime() - new Date(result.range.from).getTime(),
    ).toBe(23 * 60 * 60 * 1000);
  });

  it("returns defined zero counts and null average when no downtime exists", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-01-01",
      to: "2026-03-31",
      now,
    });

    expect(result.empty).toBe(true);
    expect(result.totalMinutes).toBe(0);
    expect(result.totalHours).toBe(0);
    expect(result.eventCount).toBe(0);
    expect(result.averageMinutesPerEvent).toBeNull();
    expect(result.trend).toEqual([]);
    expect(result.topAssets).toEqual([]);
  });

  it("returns an empty result without SQL when the requested range is wholly future", async () => {
    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-05-01",
      to: "2026-05-31",
      now,
    });

    expect(result.empty).toBe(true);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("rejects ranges over the bounded analytics horizon", async () => {
    await expect(
      buildDowntimeDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "UTC",
        from: "2023-01-01",
        to: "2026-03-31",
        now,
      }),
    ).rejects.toMatchObject({ code: "RANGE_TOO_LARGE" });

    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("rejects an asset outside the active tenant/site", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(
      buildDowntimeDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "UTC",
        from: "2026-01-01",
        to: "2026-03-31",
        assetId: "asset-other",
        now,
      }),
    ).rejects.toBeInstanceOf(DowntimeAnalyticsError);

    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
