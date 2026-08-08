import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workCount: vi.fn(),
  workFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { count: mocks.workCount, findMany: mocks.workFindMany },
  },
}));

import { BACKLOG_DETAIL_LIMIT, buildBacklogDashboard } from "@/lib/analytics/backlog";

const now = new Date("2026-08-08T10:00:00.000Z");
const openScope = {
  siteId: "site-a",
  site: { organizationId: "org-a", active: true },
  status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workCount.mockResolvedValue(0);
  mocks.workFindMany.mockResolvedValue([]);
});

describe("backlog analytics", () => {
  it("computes exact KPI formulas independently from the bounded oldest-work list", async () => {
    mocks.workCount
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(12);
    mocks.workFindMany.mockResolvedValue([{ id: "wo-oldest" }]);

    const result = await buildBacklogDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      now,
    });

    expect(result.totalOpen).toBe(15);
    expect(result.overdue).toBe(6);
    expect(result.unplanned).toBe(7);
    expect(result.urgent).toBe(8);
    expect(result.status).toEqual({
      REQUESTED: 3,
      APPROVED: 2,
      PLANNED: 4,
      IN_PROGRESS: 5,
      BLOCKED: 1,
    });
    expect(result.aging).toEqual({
      DAYS_0_6: 9,
      DAYS_7_29: 10,
      DAYS_30_89: 11,
      DAYS_90_PLUS: 12,
    });
    expect(result.empty).toBe(false);
    expect(result.oldest).toEqual([{ id: "wo-oldest" }]);
  });

  it("uses non-overlapping local-calendar age buckets in tenant/site scope", async () => {
    await buildBacklogDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      now,
    });

    const boundary7 = new Date("2026-08-02T00:00:00.000Z");
    const boundary30 = new Date("2026-07-10T00:00:00.000Z");
    const boundary90 = new Date("2026-05-11T00:00:00.000Z");
    expect(mocks.workCount).toHaveBeenNthCalledWith(9, {
      where: { ...openScope, requestedAt: { gte: boundary7, lte: now } },
    });
    expect(mocks.workCount).toHaveBeenNthCalledWith(10, {
      where: { ...openScope, requestedAt: { gte: boundary30, lt: boundary7 } },
    });
    expect(mocks.workCount).toHaveBeenNthCalledWith(11, {
      where: { ...openScope, requestedAt: { gte: boundary90, lt: boundary30 } },
    });
    expect(mocks.workCount).toHaveBeenNthCalledWith(12, {
      where: { ...openScope, requestedAt: { lt: boundary90 } },
    });
    expect(mocks.workFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: openScope,
        take: BACKLOG_DETAIL_LIMIT,
        orderBy: [{ requestedAt: "asc" }, { number: "asc" }],
      }),
    );
  });

  it("defines empty backlog as zero-valued KPIs instead of null or undefined", async () => {
    const result = await buildBacklogDashboard({
      organizationId: "org-empty",
      siteId: "site-empty",
      timeZone: "UTC",
      now,
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
});
