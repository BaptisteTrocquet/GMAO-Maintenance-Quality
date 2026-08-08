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
const baseInput = {
  organizationId: "org-a",
  siteId: "site-a",
  timeZone: "Europe/Paris",
  now,
};

describe("backlog analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue([]);
  });

  it("calculates open, overdue, due-soon, unplanned, urgent and aging KPIs from open work only", async () => {
    mocks.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(13);

    const result = await buildBacklogDashboard(baseInput);

    expect(result.totalOpen).toBe(15);
    expect(result.timezone).toBe("Europe/Paris");
    expect(result.status).toEqual({
      REQUESTED: 2,
      APPROVED: 3,
      PLANNED: 4,
      IN_PROGRESS: 5,
      BLOCKED: 1,
    });
    expect(result.overdue).toBe(6);
    expect(result.dueSoon).toBe(7);
    expect(result.unplanned).toBe(8);
    expect(result.urgent).toBe(9);
    expect(result.aging).toEqual({
      DAYS_0_6: 10,
      DAYS_7_29: 11,
      DAYS_30_89: 12,
      DAYS_90_PLUS: 13,
    });
    expect(result.empty).toBe(false);
  });

  it("scopes every query to the selected active organization/site and bounds detail rows", async () => {
    await buildBacklogDashboard(baseInput);

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
    const result = await buildBacklogDashboard(baseInput);

    expect(result.empty).toBe(true);
    expect(result.totalOpen).toBe(0);
    expect(result.overdue).toBe(0);
    expect(result.dueSoon).toBe(0);
    expect(result.unplanned).toBe(0);
    expect(result.urgent).toBe(0);
    expect(result.oldest).toEqual([]);
  });

  it("uses the local calendar for the seven-day due-soon window", async () => {
    await buildBacklogDashboard(baseInput);

    expect(mocks.count.mock.calls[6]?.[0].where.dueAt).toEqual({
      gte: now,
      lt: new Date("2026-08-14T22:00:00.000Z"),
    });
  });

  it("uses exact non-overlapping local-calendar aging boundaries and excludes future timestamps", async () => {
    await buildBacklogDashboard(baseInput);

    const agingCalls = mocks.count.mock.calls.slice(9, 13).map(([input]) => input.where.requestedAt);
    expect(agingCalls[0]).toEqual({
      gte: new Date("2026-08-01T22:00:00.000Z"),
      lte: now,
    });
    expect(agingCalls[1]).toEqual({
      gte: new Date("2026-07-09T22:00:00.000Z"),
      lt: new Date("2026-08-01T22:00:00.000Z"),
    });
    expect(agingCalls[2]).toEqual({
      gte: new Date("2026-05-10T22:00:00.000Z"),
      lt: new Date("2026-07-09T22:00:00.000Z"),
    });
    expect(agingCalls[3]).toEqual({
      lt: new Date("2026-05-10T22:00:00.000Z"),
    });
  });
});
