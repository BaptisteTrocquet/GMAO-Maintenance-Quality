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
  buildLaborUtilizationDashboard,
  LABOR_UTILIZATION_LIMIT,
  LaborUtilizationError,
} from "@/lib/analytics/labor-utilization";

const now = new Date("2026-08-08T10:00:00.000Z");

function sqlText(callIndex: number) {
  const query = mocks.queryRaw.mock.calls[callIndex]?.[0] as
    | { sql?: string; text?: string; strings?: string[] }
    | undefined;
  return query?.sql ?? query?.text ?? query?.strings?.join("?") ?? "";
}

describe("labor utilization analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.queryRaw
      .mockResolvedValueOnce([
        {
          completedWorkOrders: 4,
          recordedWorkOrders: 3,
          laborMinutes: 600,
          unassignedLaborMinutes: 120,
        },
      ])
      .mockResolvedValueOnce([
        {
          assigneeId: "user-a",
          displayName: "Synthetic Technician",
          workOrderCount: 2,
          laborMinutes: 360,
        },
        {
          assigneeId: null,
          displayName: "Unassigned",
          workOrderCount: 1,
          laborMinutes: 120,
        },
      ]);
  });

  it("calculates recording coverage and recorded-labor distribution without inventing capacity", async () => {
    const result = await buildLaborUtilizationDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-07-01",
      to: "2026-08-08",
      now,
    });

    expect(result.completedWorkOrders).toBe(4);
    expect(result.recordedWorkOrders).toBe(3);
    expect(result.recordingCoveragePercent).toBe(75);
    expect(result.laborHours).toBe(10);
    expect(result.unassignedSharePercent).toBe(20);
    expect(result.assignees[0]).toMatchObject({
      displayName: "Synthetic Technician",
      workOrderCount: 2,
      laborHours: 6,
      recordedLaborSharePercent: 60,
    });
    expect(result.definition).toMatch(/does not divide by workforce capacity/i);
  });

  it("uses bounded tenant/site aggregate queries and only positive labor for distribution", async () => {
    await buildLaborUtilizationDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-07-01",
      to: "2026-07-31",
      now,
    });

    expect(sqlText(0)).toContain("wo.status = 'COMPLETED'");
    expect(sqlText(0)).toContain('site."organizationId"');
    expect(sqlText(0)).toContain('GREATEST(COALESCE(wo."laborMinutes", 0), 0)');
    expect(sqlText(1)).toContain('LEFT JOIN "User" assignee');
    expect(sqlText(1)).toContain('wo."laborMinutes" > 0');
    expect(sqlText(1)).toContain(`LIMIT`);
    expect(LABOR_UTILIZATION_LIMIT).toBe(50);
  });

  it("preserves a 23-hour spring DST reporting day", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await buildLaborUtilizationDashboard({
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

  it("returns explicit empty semantics for a future-only window without querying", async () => {
    mocks.queryRaw.mockReset();

    const result = await buildLaborUtilizationDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-08-10",
      to: "2026-08-20",
      now,
    });

    expect(result).toMatchObject({
      empty: true,
      completedWorkOrders: 0,
      recordedWorkOrders: 0,
      recordingCoveragePercent: null,
      laborHours: 0,
      unassignedSharePercent: null,
      assignees: [],
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("validates an optional asset in the active tenant/site scope", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);
    mocks.queryRaw.mockReset();

    await expect(
      buildLaborUtilizationDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "UTC",
        from: "2026-07-01",
        to: "2026-07-31",
        assetId: "asset-other",
        now,
      }),
    ).rejects.toBeInstanceOf(LaborUtilizationError);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
