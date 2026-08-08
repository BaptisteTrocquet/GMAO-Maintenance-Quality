import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ assetFindFirst: vi.fn(), queryRaw: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: {
    asset: { findFirst: mocks.assetFindFirst },
    $queryRaw: mocks.queryRaw,
  },
}));

import {
  buildDowntimeDashboard,
  DOWNTIME_MAX_RANGE_DAYS,
  DOWNTIME_TOP_ASSET_LIMIT,
} from "@/lib/analytics/downtime";

function sqlText(callIndex: number) {
  const query = mocks.queryRaw.mock.calls[callIndex]?.[0] as { sql?: string; text?: string } | undefined;
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
        { assetId: "asset-a", code: "A-01", name: "Synthetic asset", eventCount: 2, minutes: 180 },
      ]);
  });

  it("calculates total and average downtime from bounded SQL aggregates", async () => {
    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-01-01",
      to: "2026-03-31",
      now: new Date("2026-04-01T12:00:00.000Z"),
    });

    expect(result.totalMinutes).toBe(240);
    expect(result.totalHours).toBe(4);
    expect(result.eventCount).toBe(3);
    expect(result.averageMinutesPerEvent).toBe(80);
    expect(result.empty).toBe(false);
    expect(result.topAssets[0]).toEqual(expect.objectContaining({ assetId: "asset-a", hours: 3 }));
    expect(sqlText(0)).toContain("TO_CHAR");
    expect(sqlText(0)).toContain("wo.status = 'COMPLETED'");
    expect(sqlText(1)).toContain("ORDER BY minutes DESC");
    expect(DOWNTIME_TOP_ASSET_LIMIT).toBe(10);
  });

  it("returns explicit empty/null average when no positive downtime is recorded", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-01-01",
      to: "2026-01-31",
      now: new Date("2026-02-01T12:00:00.000Z"),
    });

    expect(result.empty).toBe(true);
    expect(result.totalMinutes).toBe(0);
    expect(result.averageMinutesPerEvent).toBeNull();
  });

  it("validates an optional asset in the active organization/site before SQL", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-01-01",
      to: "2026-01-31",
      assetId: "foreign-asset",
      now: new Date("2026-02-01T12:00:00.000Z"),
    })).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("rejects ranges beyond the two-year bound before SQL", async () => {
    await expect(buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2023-01-01",
      to: "2026-03-31",
      now: new Date("2026-04-01T12:00:00.000Z"),
    })).rejects.toMatchObject({ code: "RANGE_TOO_LARGE" });
    expect(DOWNTIME_MAX_RANGE_DAYS).toBe(731);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("returns empty without SQL when the requested range is entirely future", async () => {
    const result = await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-09-01",
      to: "2026-09-30",
      now: new Date("2026-08-08T10:00:00.000Z"),
    });
    expect(result.empty).toBe(true);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
