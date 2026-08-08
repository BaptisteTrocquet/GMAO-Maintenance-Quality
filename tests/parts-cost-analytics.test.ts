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
  buildPartsCostDashboard,
  PARTS_COST_MAX_RANGE_DAYS,
  PARTS_COST_TOP_PART_LIMIT,
  PartsCostAnalyticsError,
} from "@/lib/analytics/parts-cost";

const now = new Date("2026-04-01T12:00:00.000Z");

function sqlText(callIndex: number) {
  const query = mocks.queryRaw.mock.calls[callIndex]?.[0] as
    | { sql?: string; text?: string; strings?: string[] }
    | undefined;
  return query?.sql ?? query?.text ?? query?.strings?.join("?") ?? "";
}

describe("parts cost analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.queryRaw
      .mockResolvedValueOnce([
        {
          month: "2026-01",
          lineCount: 3,
          pricedLineCount: 2,
          unpricedLineCount: 1,
          costAmount: 125,
        },
      ])
      .mockResolvedValueOnce([
        {
          partId: "part-a",
          sku: "SP-001",
          name: "Synthetic seal",
          unit: "EA",
          lineCount: 3,
          pricedLineCount: 2,
          unpricedLineCount: 1,
          quantity: 5,
          costAmount: 125,
        },
      ]);
  });

  it("calculates captured cost while surfacing unpriced consumption separately", async () => {
    const result = await buildPartsCostDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-01-01",
      to: "2026-03-31",
      now,
    });

    expect(result).toMatchObject({
      empty: false,
      lineCount: 3,
      pricedLineCount: 2,
      unpricedLineCount: 1,
      costAmount: 125,
      averageCostPerPricedLine: 62.5,
      incompleteCost: true,
    });
    expect(result).not.toHaveProperty("quantity");
    expect(result.trend[0]).not.toHaveProperty("quantity");
    expect(result.topParts[0]).toMatchObject({
      sku: "SP-001",
      quantity: 5,
      unit: "EA",
      costAmount: 125,
    });
    expect(result.definition).toContain("different units");
    expect(result.definition).toContain("Currency is not yet modeled");

    const monthlySql = sqlText(0);
    expect(monthlySql).toContain('COUNT(*) FILTER (WHERE c."unitCost" IS NULL)');
    expect(monthlySql).toContain('c.quantity * c."unitCost"');
    expect(monthlySql).not.toContain('AS quantity');
    expect(sqlText(1)).toContain('SUM(c.quantity)');
    expect(sqlText(1)).toContain('part."organizationId"');
    expect(sqlText(1)).toContain('ORDER BY "costAmount" DESC');
    expect(PARTS_COST_TOP_PART_LIMIT).toBe(10);
  });

  it("defines an empty window with zero cost totals and null averages", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await buildPartsCostDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-01-01",
      to: "2026-03-31",
      now,
    });

    expect(result.empty).toBe(true);
    expect(result.costAmount).toBe(0);
    expect(result.unpricedLineCount).toBe(0);
    expect(result.incompleteCost).toBe(false);
    expect(result.averageCostPerPricedLine).toBeNull();
    expect(result).not.toHaveProperty("quantity");
  });

  it("bounds the horizon by local calendar days across DST", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await buildPartsCostDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2024-03-31",
      to: "2026-03-31",
      now: new Date("2026-04-02T00:00:00.000Z"),
    });

    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    expect(PARTS_COST_MAX_RANGE_DAYS).toBe(731);
  });

  it("rejects reporting windows beyond the bounded local-calendar horizon", async () => {
    await expect(
      buildPartsCostDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "Europe/Paris",
        from: "2024-03-31",
        to: "2026-04-01",
        now: new Date("2026-04-02T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "RANGE_TOO_LARGE" });

    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("validates an optional asset in the active tenant/site", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(
      buildPartsCostDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "UTC",
        from: "2026-01-01",
        to: "2026-03-31",
        assetId: "asset-other",
        now,
      }),
    ).rejects.toBeInstanceOf(PartsCostAnalyticsError);

    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("returns a defined empty result without SQL for a wholly future window", async () => {
    mocks.queryRaw.mockReset();

    const result = await buildPartsCostDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-05-01",
      to: "2026-05-31",
      now,
    });

    expect(result.empty).toBe(true);
    expect(result.costAmount).toBe(0);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
