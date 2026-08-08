import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  groupBy: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: {
      count: mocks.count,
      groupBy: mocks.groupBy,
      findMany: mocks.findMany,
    },
  },
}));

import {
  BACKLOG_EXPORT_LIMIT,
  BacklogAnalyticsError,
  exportBacklogCsv,
  getBacklogAnalytics,
  normalizeBacklogRange,
} from "@/lib/analytics/backlog";

const now = new Date("2026-08-08T12:00:00.000Z");

function oldestRow() {
  return {
    id: "wo-1",
    number: "WO-0001",
    title: "Synthetic backlog item",
    status: "APPROVED",
    priority: "HIGH",
    requestedAt: new Date("2026-05-01T08:00:00.000Z"),
    dueAt: new Date("2026-05-10T08:00:00.000Z"),
    asset: { id: "asset-1", code: "EQ-001", name: "Synthetic equipment" },
    assignee: null,
    team: { name: "Maintenance A" },
  };
}

describe("backlog analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.count.mockReset();
    mocks.groupBy.mockResolvedValue([]);
    mocks.findMany.mockResolvedValue([]);
  });

  it("normalizes date-only filters to full UTC calendar days", () => {
    const range = normalizeBacklogRange({ fromDate: "2026-08-01", toDate: "2026-08-08" });

    expect(range.from?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(range.to?.toISOString()).toBe("2026-08-08T23:59:59.999Z");
    expect(range.fromDate).toBe("2026-08-01");
    expect(range.toDate).toBe("2026-08-08");
  });

  it("rejects invalid calendar dates and reversed ranges", () => {
    expect(() => normalizeBacklogRange({ fromDate: "2026-02-30" })).toThrowError(
      BacklogAnalyticsError,
    );
    expect(() =>
      normalizeBacklogRange({ fromDate: "2026-08-09", toDate: "2026-08-08" }),
    ).toThrowError(/on or before/);
  });

  it("returns deterministic backlog metrics and age buckets for one scoped query", async () => {
    mocks.count
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    mocks.groupBy.mockResolvedValue([
      { status: "APPROVED", _count: { _all: 7 } },
      { status: "IN_PROGRESS", _count: { _all: 5 } },
    ]);
    mocks.findMany.mockResolvedValue([oldestRow()]);

    const result = await getBacklogAnalytics({
      organizationId: "org-a",
      siteId: "site-a",
      assetId: "asset-1",
      fromDate: "2026-01-01",
      toDate: "2026-08-08",
      now,
    });

    expect(result.metrics).toEqual({ total: 12, overdue: 4, urgent: 2, unassigned: 3 });
    expect(result.ageBuckets).toEqual({
      days0To7: 5,
      days8To30: 4,
      days31To90: 2,
      over90Days: 1,
    });
    expect(result.byStatus).toEqual({ APPROVED: 7, IN_PROGRESS: 5 });
    expect(result.range).toEqual({
      fromDate: "2026-01-01",
      toDate: "2026-08-08",
      semantics: "requestedAt",
      timezone: "UTC",
    });
    expect(result.detailTruncated).toBe(true);

    const baseWhere = mocks.count.mock.calls[0]?.[0]?.where;
    expect(baseWhere).toEqual(
      expect.objectContaining({
        siteId: "site-a",
        assetId: "asset-1",
        site: { organizationId: "org-a", active: true },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        requestedAt: {
          gte: new Date("2026-01-01T00:00:00.000Z"),
          lte: new Date("2026-08-08T23:59:59.999Z"),
        },
      }),
    );

    const ageCalls = mocks.count.mock.calls.slice(4).map((call) => call[0].where.AND[1].requestedAt);
    expect(ageCalls).toEqual([
      { gte: new Date("2026-08-01T12:00:00.000Z"), lte: now },
      { gte: new Date("2026-07-09T12:00:00.000Z"), lt: new Date("2026-08-01T12:00:00.000Z") },
      { gte: new Date("2026-05-10T12:00:00.000Z"), lt: new Date("2026-07-09T12:00:00.000Z") },
      { lt: new Date("2026-05-10T12:00:00.000Z") },
    ]);
  });

  it("defines empty backlog behavior without fabricated values", async () => {
    for (let index = 0; index < 8; index += 1) mocks.count.mockResolvedValueOnce(0);

    const result = await getBacklogAnalytics({
      organizationId: "org-a",
      siteId: "site-a",
      now,
    });

    expect(result.metrics).toEqual({ total: 0, overdue: 0, urgent: 0, unassigned: 0 });
    expect(result.ageBuckets).toEqual({
      days0To7: 0,
      days8To30: 0,
      days31To90: 0,
      over90Days: 0,
    });
    expect(result.byStatus).toEqual({});
    expect(result.oldest).toEqual([]);
    expect(result.detailTruncated).toBe(false);
  });

  it("exports bounded RFC-style CSV with escaped user-visible fields", async () => {
    mocks.findMany.mockResolvedValue([
      {
        number: "WO-0001",
        title: 'Inspect, then replace "seal"',
        status: "APPROVED",
        priority: "HIGH",
        requestedAt: new Date("2026-08-01T08:00:00.000Z"),
        plannedStart: null,
        dueAt: new Date("2026-08-10T08:00:00.000Z"),
        asset: { code: "EQ-001", name: "Synthetic equipment" },
        assignee: { displayName: "Demo Technician" },
        team: null,
      },
    ]);

    const result = await exportBacklogCsv({ organizationId: "org-a", siteId: "site-a" });

    expect(result.truncated).toBe(false);
    expect(result.rowCount).toBe(1);
    expect(result.limit).toBe(BACKLOG_EXPORT_LIMIT);
    expect(result.csv).toContain('"Inspect, then replace ""seal"""');
    expect(result.csv).toContain("2026-08-01T08:00:00.000Z");
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: BACKLOG_EXPORT_LIMIT + 1 }),
    );
  });
});
