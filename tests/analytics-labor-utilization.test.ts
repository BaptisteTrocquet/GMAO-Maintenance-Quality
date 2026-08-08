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

import { buildLaborUtilization, LaborUtilizationError } from "@/lib/analytics/labor-utilization";

const now = new Date("2026-08-08T10:00:00.000Z");

function sqlText(callIndex: number) {
  const query = mocks.queryRaw.mock.calls[callIndex]?.[0] as { sql?: string; text?: string } | undefined;
  return query?.sql ?? query?.text ?? "";
}

describe("labor utilization analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.queryRaw
      .mockResolvedValueOnce([{
        completedCount: 10,
        recordedCount: 8,
        excludedMissingLabor: 2,
        totalMinutes: 480,
        personMinutes: 300,
        teamMinutes: 120,
        unassignedMinutes: 60,
      }])
      .mockResolvedValueOnce([
        { id: "user-1", label: "Synthetic Technician", workOrderCount: 3, minutes: 180 },
        { id: "user-2", label: "Synthetic Technician 2", workOrderCount: 2, minutes: 120 },
      ])
      .mockResolvedValueOnce([
        { id: "team-1", label: "Synthetic Team", workOrderCount: 2, minutes: 120 },
      ]);
  });

  it("reports recorded labor, capture coverage and non-overlapping attribution shares", async () => {
    const result = await buildLaborUtilization({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-07-01",
      to: "2026-08-08",
      now,
    });

    expect(result.totalHours).toBe(8);
    expect(result.completedWorkOrders).toBe(10);
    expect(result.recordedWorkOrders).toBe(8);
    expect(result.excludedMissingLabor).toBe(2);
    expect(result.captureCoveragePercent).toBe(80);
    expect(result.personMinutes).toBe(300);
    expect(result.teamMinutes).toBe(120);
    expect(result.unassignedMinutes).toBe(60);
    expect(result.attributedPercent).toBe(87.5);
    expect(result.people[0]).toMatchObject({ id: "user-1", hours: 3, sharePercent: 37.5 });
    expect(result.teams[0]).toMatchObject({ id: "team-1", hours: 2, sharePercent: 25 });
    expect(result.definition).toContain("not capacity utilization");
  });

  it("scopes completed-work queries and assigns team labor only when no person is assigned", async () => {
    await buildLaborUtilization({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-07-01",
      to: "2026-07-31",
      now,
    });

    expect(sqlText(0)).toContain("wo.status = 'COMPLETED'");
    expect(sqlText(0)).toContain('wo."completedAt"');
    expect(sqlText(1)).toContain('wo."assigneeId" IS NOT NULL');
    expect(sqlText(2)).toContain('wo."assigneeId" IS NULL');
    expect(sqlText(2)).toContain('wo."teamId" IS NOT NULL');
  });

  it("preserves DST-local date boundaries", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw
      .mockResolvedValueOnce([{ completedCount: 0, recordedCount: 0, excludedMissingLabor: 0, totalMinutes: 0, personMinutes: 0, teamMinutes: 0, unassignedMinutes: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await buildLaborUtilization({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-03-29",
      to: "2026-03-29",
      now: new Date("2026-04-01T00:00:00.000Z"),
    });

    expect(result.range.from).toBe("2026-03-28T23:00:00.000Z");
    expect(result.range.toExclusive).toBe("2026-03-29T22:00:00.000Z");
  });

  it("returns explicit empty semantics for a future-only range", async () => {
    mocks.queryRaw.mockReset();

    const result = await buildLaborUtilization({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-08-10",
      to: "2026-08-20",
      now,
    });

    expect(result).toMatchObject({ empty: true, totalMinutes: 0, captureCoveragePercent: null });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("validates an optional asset inside the active tenant/site scope", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(buildLaborUtilization({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-07-01",
      to: "2026-07-31",
      assetId: "asset-other",
      now,
    })).rejects.toBeInstanceOf(LaborUtilizationError);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
