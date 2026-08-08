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

import { buildBacklogDashboard, exportBacklogCsv } from "@/lib/analytics/backlog";

const now = new Date("2026-03-29T12:00:00.000Z");
const filters = {
  organizationId: "org-a",
  siteId: "site-a",
  timeZone: "Europe/Paris",
  assetId: "asset-a",
  from: "2026-03-29",
  to: "2026-03-29",
};

describe("backlog analytics filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue([]);
  });

  it("applies the site-calendar requestedAt window and asset to all backlog KPI scopes", async () => {
    const result = await buildBacklogDashboard({ ...filters, now });

    const expectedRequestedAt = {
      gte: new Date("2026-03-28T23:00:00.000Z"),
      lt: new Date("2026-03-29T22:00:00.000Z"),
    };

    for (const [call] of mocks.count.mock.calls.slice(0, 9)) {
      expect(call.where).toMatchObject({
        siteId: "site-a",
        assetId: "asset-a",
        site: { organizationId: "org-a", active: true },
        requestedAt: expectedRequestedAt,
      });
    }
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-a",
          assetId: "asset-a",
          requestedAt: expectedRequestedAt,
        }),
      }),
    );
    expect(result.filters).toEqual({
      assetId: "asset-a",
      from: "2026-03-29",
      to: "2026-03-29",
      dateField: "requestedAt",
    });
  });

  it("intersects aging buckets with the selected requestedAt range instead of replacing it", async () => {
    await buildBacklogDashboard({ ...filters, now });

    const agingWhere = mocks.count.mock.calls[9]?.[0].where;
    expect(agingWhere.AND).toEqual([
      expect.objectContaining({
        assetId: "asset-a",
        requestedAt: {
          gte: new Date("2026-03-28T23:00:00.000Z"),
          lt: new Date("2026-03-29T22:00:00.000Z"),
        },
      }),
      { requestedAt: expect.objectContaining({ lte: now }) },
    ]);
  });

  it("uses the same date and asset scope for CSV export", async () => {
    await exportBacklogCsv(filters);

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
          assetId: "asset-a",
          requestedAt: {
            gte: new Date("2026-03-28T23:00:00.000Z"),
            lt: new Date("2026-03-29T22:00:00.000Z"),
          },
          status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
        },
      }),
    );
  });
});
