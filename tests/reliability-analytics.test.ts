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
  buildReliabilityDashboard,
  ReliabilityAnalyticsError,
} from "@/lib/analytics/reliability";

const now = new Date("2026-08-08T10:00:00.000Z");

function sqlText(callIndex: number) {
  const query = mocks.queryRaw.mock.calls[callIndex]?.[0] as
    | { sql?: string; text?: string }
    | undefined;
  return query?.sql ?? query?.text ?? "";
}

describe("reliability analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 4, excludedIncomplete: 1, hours: 3.25 }])
      .mockResolvedValueOnce([{ intervalCount: 3, assetCount: 2, hours: 120 }]);
  });

  it("returns MTTR and calendar-time MTBF samples with explicit formulas", async () => {
    const result = await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-07-01",
      to: "2026-08-08",
      now,
    });

    expect(result.mttr).toEqual({ hours: 3.25, sampleCount: 4, excludedIncomplete: 1 });
    expect(result.mtbf).toEqual({ hours: 120, sampleCount: 3, assetCount: 2 });
    expect(result.range.from).toBe("2026-06-30T22:00:00.000Z");
    expect(result.range.toExclusive).toBe(now.toISOString());
    expect(result.definitions.mttr).toContain("counted separately");
    expect(result.definitions.mtbf).toContain("Calendar-time MTBF");
    expect(result.definitions.mtbf).toContain("latest completed corrective repair");
    expect(result.definitions.mtbf).toContain("not operating-hours MTBF");

    expect(sqlText(0)).toContain('AVG(\n          EXTRACT(EPOCH FROM (wo."completedAt" - wo."startedAt")) / 3600.0');
    expect(sqlText(0)).toContain('AS "excludedIncomplete"');
    expect(sqlText(0)).toContain('wo."startedAt" >= wo."requestedAt"');
    expect(sqlText(0)).toContain("wo.type = 'CORRECTIVE'");
    expect(sqlText(1)).toContain('SELECT MAX(previous."completedAt")');
    expect(sqlText(1)).toContain("previous.status = 'COMPLETED'");
    expect(sqlText(1)).toContain('previous."completedAt" < wo."requestedAt"');
    expect(sqlText(1)).toContain('AS "previousCompletedAt"');
    expect(sqlText(1)).toContain('"requestedAt" - "previousCompletedAt"');
    expect(sqlText(1)).toContain("wo.status <> 'CANCELLED'");
  });

  it("defines missing samples as null KPI values while preserving incomplete-data counts", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 0, excludedIncomplete: 2, hours: null }])
      .mockResolvedValueOnce([{ intervalCount: 0, assetCount: 0, hours: null }]);

    const result = await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      now,
    });

    expect(result.mttr).toEqual({ hours: null, sampleCount: 0, excludedIncomplete: 2 });
    expect(result.mtbf).toEqual({ hours: null, sampleCount: 0, assetCount: 0 });
  });

  it("validates an optional asset inside the active tenant/site before querying", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(
      buildReliabilityDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "UTC",
        assetId: "asset-other",
        now,
      }),
    ).rejects.toBeInstanceOf(ReliabilityAnalyticsError);

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

  it("rejects a reporting window that is entirely in the future", async () => {
    await expect(
      buildReliabilityDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "Europe/Paris",
        from: "2026-08-10",
        to: "2026-08-20",
        now,
      }),
    ).rejects.toMatchObject({ code: "RANGE_IN_FUTURE" });

    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
