import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workOrderCount: vi.fn(),
  workOrderGroupBy: vi.fn(),
  workOrderFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: {
      count: mocks.workOrderCount,
      groupBy: mocks.workOrderGroupBy,
      findMany: mocks.workOrderFindMany,
    },
  },
}));

import {
  BACKLOG_DETAIL_LIMIT,
  BACKLOG_EXPORT_LIMIT,
  exportBacklogCsv,
  getBacklogAnalytics,
} from "@/lib/analytics/backlog";

const now = new Date("2026-04-01T10:00:00.000Z");
const input = {
  organizationId: "org-a",
  siteId: "site-a",
  timeZone: "Europe/Paris",
  assetId: "asset-a",
  fromDate: "2026-03-29",
  toDate: "2026-03-30",
  now,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workOrderCount.mockResolvedValue(0);
  mocks.workOrderGroupBy.mockResolvedValue([]);
  mocks.workOrderFindMany.mockResolvedValue([]);
});

describe("backlog analytics", () => {
  it("uses the same tenant/site/asset and local requested-date scope for KPI formulas", async () => {
    mocks.workOrderCount
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2);
    mocks.workOrderGroupBy.mockResolvedValue([
      { status: "REQUESTED", _count: { _all: 4 } },
      { status: "APPROVED", _count: { _all: 2 } },
      { status: "PLANNED", _count: { _all: 3 } },
      { status: "IN_PROGRESS", _count: { _all: 1 } },
      { status: "BLOCKED", _count: { _all: 2 } },
    ]);
    mocks.workOrderFindMany.mockResolvedValue([
      {
        id: "wo-1",
        number: "WO-0001",
        title: "Synthetic backlog item",
        status: "BLOCKED",
        priority: "HIGH",
        requestedAt: new Date("2026-03-29T06:00:00.000Z"),
        plannedStart: null,
        dueAt: new Date("2026-03-31T06:00:00.000Z"),
        asset: { id: "asset-a", code: "EQ-001", name: "Synthetic pump" },
        assignee: null,
        team: null,
      },
    ]);

    const result = await getBacklogAnalytics(input);

    expect(result.metrics).toEqual({
      total: 12,
      overdue: 3,
      blocked: 2,
      urgent: 2,
      unassigned: 4,
    });
    expect(result.ageBuckets).toEqual({
      days0To6: 3,
      days7To29: 4,
      days30To89: 3,
      days90Plus: 2,
    });
    expect(result.byStatus).toMatchObject({
      REQUESTED: 4,
      APPROVED: 2,
      PLANNED: 3,
      IN_PROGRESS: 1,
      BLOCKED: 2,
      COMPLETED: 0,
      CANCELLED: 0,
    });
    expect(result.range).toEqual({
      fromDate: "2026-03-29",
      toDate: "2026-03-30",
      semantics: "requestedAt",
      timeZone: "Europe/Paris",
      fromUtc: "2026-03-28T23:00:00.000Z",
      toExclusiveUtc: "2026-03-30T22:00:00.000Z",
    });

    const totalWhere = mocks.workOrderCount.mock.calls[0]?.[0]?.where;
    expect(totalWhere).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
      requestedAt: {
        lte: now,
        gte: new Date("2026-03-28T23:00:00.000Z"),
        lt: new Date("2026-03-30T22:00:00.000Z"),
      },
      assetId: "asset-a",
    });
  });

  it("uses non-overlapping aging boundaries and bounds oldest detail", async () => {
    mocks.workOrderCount.mockResolvedValue(1);
    mocks.workOrderFindMany.mockResolvedValue(
      Array.from({ length: BACKLOG_DETAIL_LIMIT }, (_, index) => ({ id: `wo-${index}` })),
    );

    const result = await getBacklogAnalytics({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      now,
    });

    const seven = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirty = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninety = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(mocks.workOrderCount.mock.calls[4]?.[0]?.where).toEqual(
      expect.objectContaining({ AND: [expect.any(Object), { requestedAt: { gt: seven, lte: now } }] }),
    );
    expect(mocks.workOrderCount.mock.calls[5]?.[0]?.where).toEqual(
      expect.objectContaining({ AND: [expect.any(Object), { requestedAt: { gt: thirty, lte: seven } }] }),
    );
    expect(mocks.workOrderCount.mock.calls[6]?.[0]?.where).toEqual(
      expect.objectContaining({ AND: [expect.any(Object), { requestedAt: { gt: ninety, lte: thirty } }] }),
    );
    expect(mocks.workOrderCount.mock.calls[7]?.[0]?.where).toEqual(
      expect.objectContaining({ AND: [expect.any(Object), { requestedAt: { lte: ninety } }] }),
    );
    expect(mocks.workOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: BACKLOG_DETAIL_LIMIT }),
    );
    expect(result.detailTruncated).toBe(false);
  });

  it("defines a stable empty-data result", async () => {
    const result = await getBacklogAnalytics({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      now,
    });

    expect(result.empty).toBe(true);
    expect(result.metrics).toEqual({ total: 0, overdue: 0, blocked: 0, urgent: 0, unassigned: 0 });
    expect(result.oldest).toEqual([]);
    expect(result.detailTruncated).toBe(false);
  });

  it("escapes CSV cells and enforces the export row limit", async () => {
    const rows = Array.from({ length: BACKLOG_EXPORT_LIMIT + 1 }, (_, index) => ({
      number: `WO-${index}`,
      title: index === 0 ? 'Pump, "north"\nline' : "Synthetic item",
      status: "REQUESTED",
      priority: "NORMAL",
      requestedAt: new Date("2026-03-29T06:00:00.000Z"),
      plannedStart: null,
      dueAt: null,
      asset: index === 0 ? { code: "EQ-001", name: "Pump, north" } : null,
      assignee: null,
      team: null,
    }));
    mocks.workOrderFindMany.mockResolvedValue(rows);

    const result = await exportBacklogCsv({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      now,
    });

    expect(result.rowCount).toBe(BACKLOG_EXPORT_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(BACKLOG_EXPORT_LIMIT);
    expect(result.csv).toContain('"Pump, ""north""\nline"');
    expect(result.csv).toContain('"Pump, north"');
    expect(mocks.workOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: BACKLOG_EXPORT_LIMIT + 1 }),
    );
  });
});
