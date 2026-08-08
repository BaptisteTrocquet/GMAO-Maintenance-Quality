import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: {
      count: mocks.count,
      findMany: mocks.findMany,
    },
  },
}));

import { BACKLOG_DETAIL_LIMIT, buildBacklogDashboard } from "@/lib/analytics/backlog";

const NOW = new Date("2026-08-08T10:00:00.000Z");

function setCounts(values: number[]) {
  for (const value of values) mocks.count.mockResolvedValueOnce(value);
}

describe("backlog analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
  });

  it("calculates backlog totals, exceptions and aging buckets from open work only", async () => {
    setCounts([
      3, // requested
      2, // approved
      4, // planned
      1, // in progress
      1, // blocked
      5, // overdue
      6, // unplanned
      2, // urgent
      4, // age 0-6
      3, // age 7-29
      2, // age 30-89
      2, // age 90+
    ]);
    mocks.findMany.mockResolvedValue([
      {
        id: "wo-old",
        number: "WO-000001",
        title: "Synthetic inspection",
        status: "REQUESTED",
        priority: "HIGH",
        requestedAt: new Date("2026-01-01T00:00:00.000Z"),
        dueAt: null,
        asset: { code: "ASSET-001", name: "Synthetic asset" },
      },
    ]);

    const result = await buildBacklogDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      now: NOW,
    });

    expect(result).toMatchObject({
      generatedAt: NOW.toISOString(),
      empty: false,
      totalOpen: 11,
      overdue: 5,
      unplanned: 6,
      urgent: 2,
      status: {
        REQUESTED: 3,
        APPROVED: 2,
        PLANNED: 4,
        IN_PROGRESS: 1,
        BLOCKED: 1,
      },
      aging: {
        DAYS_0_6: 4,
        DAYS_7_29: 3,
        DAYS_30_89: 2,
        DAYS_90_PLUS: 2,
      },
    });
    expect(result.oldest).toHaveLength(1);

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
          status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
        }),
        orderBy: [{ requestedAt: "asc" }, { number: "asc" }],
        take: BACKLOG_DETAIL_LIMIT,
      }),
    );
  });

  it("defines empty backlog as zero-valued KPIs instead of null or undefined", async () => {
    setCounts(Array.from({ length: 12 }, () => 0));

    const result = await buildBacklogDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      now: NOW,
    });

    expect(result.empty).toBe(true);
    expect(result.totalOpen).toBe(0);
    expect(result.overdue).toBe(0);
    expect(result.unplanned).toBe(0);
    expect(result.urgent).toBe(0);
    expect(Object.values(result.status)).toEqual([0, 0, 0, 0, 0]);
    expect(Object.values(result.aging)).toEqual([0, 0, 0, 0]);
    expect(result.oldest).toEqual([]);
  });

  it("uses non-overlapping deterministic UTC aging boundaries", async () => {
    setCounts(Array.from({ length: 12 }, () => 0));

    await buildBacklogDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      now: NOW,
    });

    const sevenDaysAgo = new Date("2026-08-01T10:00:00.000Z");
    const thirtyDaysAgo = new Date("2026-07-09T10:00:00.000Z");
    const ninetyDaysAgo = new Date("2026-05-10T10:00:00.000Z");

    expect(mocks.count).toHaveBeenNthCalledWith(
      9,
      expect.objectContaining({
        where: expect.objectContaining({ requestedAt: { gte: sevenDaysAgo, lte: NOW } }),
      }),
    );
    expect(mocks.count).toHaveBeenNthCalledWith(
      10,
      expect.objectContaining({
        where: expect.objectContaining({ requestedAt: { gte: thirtyDaysAgo, lt: sevenDaysAgo } }),
      }),
    );
    expect(mocks.count).toHaveBeenNthCalledWith(
      11,
      expect.objectContaining({
        where: expect.objectContaining({ requestedAt: { gte: ninetyDaysAgo, lt: thirtyDaysAgo } }),
      }),
    );
    expect(mocks.count).toHaveBeenNthCalledWith(
      12,
      expect.objectContaining({
        where: expect.objectContaining({ requestedAt: { lt: ninetyDaysAgo } }),
      }),
    );
  });
});
