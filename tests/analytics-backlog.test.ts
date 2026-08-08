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

const now = new Date("2026-08-08T10:00:00.000Z");

describe("backlog analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue([]);
  });

  it("calculates open, overdue, unplanned, urgent and aging buckets from open work only", async () => {
    mocks.count
      .mockResolvedValueOnce(2) // requested
      .mockResolvedValueOnce(3) // approved
      .mockResolvedValueOnce(4) // planned
      .mockResolvedValueOnce(5) // in progress
      .mockResolvedValueOnce(1) // blocked
      .mockResolvedValueOnce(6) // overdue
      .mockResolvedValueOnce(7) // unplanned
      .mockResolvedValueOnce(8) // urgent
      .mockResolvedValueOnce(9) // 0-6
      .mockResolvedValueOnce(10) // 7-29
      .mockResolvedValueOnce(11) // 30-89
      .mockResolvedValueOnce(12); // 90+

    const result = await buildBacklogDashboard({ organizationId: "org-a", siteId: "site-a", now });

    expect(result.totalOpen).toBe(15);
    expect(result.status).toEqual({
      REQUESTED: 2,
      APPROVED: 3,
      PLANNED: 4,
      IN_PROGRESS: 5,
      BLOCKED: 1,
    });
    expect(result.overdue).toBe(6);
    expect(result.unplanned).toBe(7);
    expect(result.urgent).toBe(8);
    expect(result.aging).toEqual({
      DAYS_0_6: 9,
      DAYS_7_29: 10,
      DAYS_30_89: 11,
      DAYS_90_PLUS: 12,
    });
    expect(result.empty).toBe(false);
  });

  it("scopes every query to the selected active organization/site and bounds detail rows", async () => {
    await buildBacklogDashboard({ organizationId: "org-a", siteId: "site-a", now });

    for (const [input] of mocks.count.mock.calls) {
      expect(input.where).toMatchObject({
        siteId: "site-a",
        site: { organizationId: "org-a", active: true },
      });
    }
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

  it("defines empty backlog metrics as zero instead of undefined", async () => {
    const result = await buildBacklogDashboard({ organizationId: "org-a", siteId: "site-a", now });

    expect(result.empty).toBe(true);
    expect(result.totalOpen).toBe(0);
    expect(result.overdue).toBe(0);
    expect(result.unplanned).toBe(0);
    expect(result.urgent).toBe(0);
    expect(result.oldest).toEqual([]);
  });

  it("uses non-overlapping aging boundaries and excludes future requested timestamps", async () => {
    await buildBacklogDashboard({ organizationId: "org-a", siteId: "site-a", now });

    const agingCalls = mocks.count.mock.calls.slice(8, 12).map(([input]) => input.where.requestedAt);
    expect(agingCalls[0]).toEqual({
      gte: new Date("2026-08-01T10:00:00.000Z"),
      lte: now,
    });
    expect(agingCalls[1]).toEqual({
      gte: new Date("2026-07-09T10:00:00.000Z"),
      lt: new Date("2026-08-01T10:00:00.000Z"),
    });
    expect(agingCalls[2]).toEqual({
      gte: new Date("2026-05-10T10:00:00.000Z"),
      lt: new Date("2026-07-09T10:00:00.000Z"),
    });
    expect(agingCalls[3]).toEqual({ lt: new Date("2026-05-10T10:00:00.000Z") });
  });
});
