import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  listLaborCapacityProfiles: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    asset: { findFirst: mocks.assetFindFirst },
    $queryRaw: mocks.queryRaw,
  },
}));
vi.mock("@/lib/analytics/labor-capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/labor-capacity")>();
  return { ...actual, listLaborCapacityProfiles: mocks.listLaborCapacityProfiles };
});

import {
  buildLaborUtilization,
  LABOR_UTILIZATION_TOP_LIMIT,
  LaborUtilizationError,
} from "@/lib/analytics/labor-utilization";

const now = new Date("2026-08-08T10:00:00.000Z");

function sqlText(callIndex: number) {
  const query = mocks.queryRaw.mock.calls[callIndex]?.[0] as
    | { sql?: string; text?: string; strings?: string[] }
    | undefined;
  return query?.sql ?? query?.text ?? query?.strings?.join("?") ?? "";
}

function mockRecordedLabor() {
  mocks.queryRaw
    .mockResolvedValueOnce([
      {
        completedCount: 5,
        recordedCount: 4,
        excludedMissingLabor: 1,
        totalMinutes: 720,
        personMinutes: 480,
        teamMinutes: 180,
        unassignedMinutes: 60,
      },
    ])
    .mockResolvedValueOnce([
      { id: "user-a", label: "Synthetic Technician", workOrderCount: 2, minutes: 360 },
      { id: "user-b", label: "Second Technician", workOrderCount: 1, minutes: 120 },
    ])
    .mockResolvedValueOnce([
      { id: "team-a", label: "Synthetic Team", workOrderCount: 1, minutes: 180 },
    ]);
}

describe("labor utilization analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.listLaborCapacityProfiles.mockResolvedValue([]);
    mockRecordedLabor();
  });

  it("preserves captured-labor distribution when no capacity baseline exists", async () => {
    const result = await buildLaborUtilization({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-07-01",
      to: "2026-08-08",
      now,
    });

    expect(result.completedWorkOrders).toBe(5);
    expect(result.recordedWorkOrders).toBe(4);
    expect(result.excludedMissingLabor).toBe(1);
    expect(result.captureCoveragePercent).toBe(80);
    expect(result.totalHours).toBe(12);
    expect(result.personMinutes).toBe(480);
    expect(result.teamMinutes).toBe(180);
    expect(result.unassignedMinutes).toBe(60);
    expect(result.attributedPercent).toBeCloseTo((660 / 720) * 100);
    expect(result.capacityMode).toBe("RECORDED_ONLY");
    expect(result.utilizationPercent).toBeNull();
    expect(result.people[0]).toMatchObject({
      id: "user-a",
      kind: "PERSON",
      hours: 6,
      weeklyCapacityMinutes: null,
      utilizationPercent: null,
    });
    expect(result.teams[0]).toMatchObject({ id: "team-a", kind: "TEAM", hours: 3 });
  });

  it("calculates capacity utilization without hiding uncovered person labor or team labor", async () => {
    mocks.listLaborCapacityProfiles.mockResolvedValue([
      {
        id: "profile-a",
        organizationId: "org-a",
        siteId: "site-a",
        userId: "user-a",
        displayName: "Synthetic Technician",
        weeklyCapacityMinutes: 2100,
        active: true,
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);

    const result = await buildLaborUtilization({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-08-03",
      to: "2026-08-07",
      now,
    });

    expect(result.capacityMode).toBe("CONFIGURED_BASELINE");
    expect(result.businessDays).toBe(5);
    expect(result.capacityMinutes).toBe(2100);
    expect(result.capacityCoveredLaborMinutes).toBe(360);
    expect(result.capacityCoveragePercent).toBe(75);
    expect(result.utilizationPercent).toBeCloseTo((360 / 2100) * 100);
    expect(result.people.find((point) => point.id === "user-a")).toMatchObject({
      weeklyCapacityMinutes: 2100,
      capacityMinutes: 2100,
    });
    expect(result.people.find((point) => point.id === "user-a")?.utilizationPercent).toBeCloseTo(
      (360 / 2100) * 100,
    );
    expect(result.people.find((point) => point.id === "user-b")?.utilizationPercent).toBeNull();
    expect(result.teamMinutes).toBe(180);
    expect(result.definition).toMatch(/team-only and unassigned labor remain visible/i);
  });

  it("queries only completed work inside the tenant/site window and bounds distribution rows", async () => {
    await buildLaborUtilization({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-07-01",
      to: "2026-07-31",
      now,
    });

    expect(sqlText(0)).toContain("wo.status = 'COMPLETED'");
    expect(sqlText(0)).toContain('site."organizationId"');
    expect(sqlText(0)).toContain('wo."completedAt" >=');
    expect(sqlText(1)).toContain('INNER JOIN "User" user_account');
    expect(sqlText(1)).toContain('wo."laborMinutes" > 0');
    expect(sqlText(2)).toContain('INNER JOIN "MaintenanceTeam" team');
    expect(LABOR_UTILIZATION_TOP_LIMIT).toBe(25);
  });

  it("preserves a 23-hour spring DST reporting day", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

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
    expect(result.businessDays).toBe(0);
  });

  it("returns explicit empty semantics for a future-only window without analytics queries", async () => {
    mocks.queryRaw.mockReset();

    const result = await buildLaborUtilization({
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
      captureCoveragePercent: null,
      totalHours: 0,
      attributedPercent: null,
      capacityMode: "RECORDED_ONLY",
      utilizationPercent: null,
      people: [],
      teams: [],
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("validates an optional asset in the active tenant/site scope", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);
    mocks.queryRaw.mockReset();

    await expect(
      buildLaborUtilization({
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
