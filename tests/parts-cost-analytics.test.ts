import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  assetFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: mocks.queryRaw,
    asset: { findFirst: mocks.assetFindFirst },
  },
}));

import {
  buildPartsCostDashboard,
  PARTS_COST_TOP_PART_LIMIT,
  PartsCostAnalyticsError,
} from "@/lib/analytics/parts-cost";

const now = new Date("2026-08-08T10:00:00.000Z");

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
          month: "2026-06",
          lineCount: 3,
          pricedLineCount: 2,
          unpricedLineCount: 1,
          quantity: 5,
          costAmount: 120,
        },
        {
          month: "2026-07",
          lineCount: 2,
          pricedLineCount: 2,
          unpricedLineCount: 0,
          quantity: 4,
          costAmount: 80,
        },
      ])
      .mockResolvedValueOnce([
        {
          partId: "part-a",
          sku: "SP-001",
          name: "Synthetic spare",
          unit: "EA",
          lineCount: 3,
          pricedLineCount: 2,
          unpricedLineCount: 1,
          quantity: 5,
          costAmount: 140,
        },
      ]);
  });

  it("aggregates captured consumption cost while reporting unpriced lines separately", async () => {
    const result = await buildPartsCostDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-06-01",
      to: "2026-07-31",
      now,
    });

    expect(result).toMatchObject({
      empty: false,
      lineCount: 5,
      pricedLineCount: 4,
      unpricedLineCount: 1,
      quantity: 9,
      costAmount: 200,
      averageCostPerPricedLine: 50,
      incompleteCost: true,
    });
    expect(result.trend).toHaveLength(2);
    expect(result.topParts[0]).toMatchObject({
      partId: "part-a",
      sku: "SP-001",
      costAmount: 140,
      unpricedLineCount: 1,
    });
    expect(result.definition).toContain("missing unitCost");
    expect(result.definition).toContain("Currency is not yet modeled");
  });

  it("uses captured consumption unitCost and never silently prices missing costs at a fallback value", async () => {
    await buildPartsCostDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-06-01",
      to: "2026-07-31",
      now,
    });

    const monthlySql = sqlText(0);
    expect(monthlySql).toContain('c."unitCost" IS NOT NULL');
    expect(monthlySql).toContain('c.quantity * c."unitCost"');
    expect(monthlySql).toContain('c."unitCost" IS NULL');
    expect(monthlySql).toContain('part."organizationId"');
    expect(monthlySql).toContain('wo."siteId"');
    expect(sqlText(1)).toContain("ORDER BY \"costAmount\" DESC");
    expect(PARTS_COST_TOP_PART_LIMIT).toBe(10);
  });

  it("uses DST-safe local-calendar bounds", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await buildPartsCostDashboard({
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

  it("validates an optional asset inside the active tenant/site", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(
      buildPartsCostDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "UTC",
        from: "2026-06-01",
        to: "2026-07-31",
        assetId: "asset-other",
        now,
      }),
    ).rejects.toBeInstanceOf(PartsCostAnalyticsError);

    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("returns explicit empty and null-average semantics for a future-only range", async () => {
    mocks.queryRaw.mockReset();

    const result = await buildPartsCostDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-08-10",
      to: "2026-08-20",
      now,
    });

    expect(result).toMatchObject({
      empty: true,
      lineCount: 0,
      pricedLineCount: 0,
      unpricedLineCount: 0,
      costAmount: 0,
      averageCostPerPricedLine: null,
      incompleteCost: false,
      trend: [],
      topParts: [],
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("rejects reporting windows beyond the bounded analytics horizon", async () => {
    await expect(
      buildPartsCostDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "UTC",
        from: "2023-01-01",
        to: "2026-07-31",
        now,
      }),
    ).rejects.toMatchObject({ code: "RANGE_TOO_LARGE" });

    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
