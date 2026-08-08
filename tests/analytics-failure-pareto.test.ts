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
  buildFailurePareto,
  FAILURE_PARETO_LIMIT,
  FailureParetoError,
} from "@/lib/analytics/failure-pareto";

const now = new Date("2026-08-08T10:00:00.000Z");

function sqlText() {
  const query = mocks.queryRaw.mock.calls[0]?.[0] as { sql?: string; text?: string } | undefined;
  return query?.sql ?? query?.text ?? "";
}

describe("failure Pareto analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.queryRaw.mockResolvedValue([
      {
        assetId: "asset-a",
        code: "AST-001",
        name: "Synthetic asset A",
        eventCount: 6,
        downtimeMinutes: 240,
        totalEventCount: 10,
      },
      {
        assetId: "asset-b",
        code: "AST-002",
        name: "Synthetic asset B",
        eventCount: 3,
        downtimeMinutes: 30,
        totalEventCount: 10,
      },
    ]);
  });

  it("computes event share and cumulative Pareto percentages against all matching events", async () => {
    const result = await buildFailurePareto({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-07-01",
      to: "2026-08-08",
      now,
    });

    expect(result.totalEventCount).toBe(10);
    expect(result.rankedEventCount).toBe(9);
    expect(result.points).toEqual([
      expect.objectContaining({
        assetId: "asset-a",
        eventCount: 6,
        downtimeMinutes: 240,
        eventSharePercent: 60,
        cumulativePercent: 60,
      }),
      expect.objectContaining({
        assetId: "asset-b",
        eventCount: 3,
        downtimeMinutes: 30,
        eventSharePercent: 30,
        cumulativePercent: 90,
      }),
    ]);
    expect(result.definition).toContain("not a failure-mode Pareto");
  });

  it("uses a bounded aggregate query scoped to active tenant/site corrective work", async () => {
    await buildFailurePareto({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-07-01",
      to: "2026-07-31",
      now,
    });

    const text = sqlText();
    expect(text).toContain("COUNT(*)");
    expect(text).toContain('SUM(ranked."eventCount") OVER ()');
    expect(text).toContain("wo.type = 'CORRECTIVE'");
    expect(text).toContain("wo.status <> 'CANCELLED'");
    expect(text).toContain('asset."archivedAt" IS NULL');
    expect(text).toContain('ORDER BY ranked."eventCount" DESC');
    expect(FAILURE_PARETO_LIMIT).toBe(25);
  });

  it("preserves a 23-hour spring DST reporting day", async () => {
    mocks.queryRaw.mockResolvedValue([]);

    const result = await buildFailurePareto({
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

  it("returns explicit empty semantics for a future-only window without querying", async () => {
    mocks.queryRaw.mockReset();

    const result = await buildFailurePareto({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "UTC",
      from: "2026-08-10",
      to: "2026-08-20",
      now,
    });

    expect(result).toMatchObject({ empty: true, totalEventCount: 0, rankedEventCount: 0, points: [] });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("validates an optional asset inside the active tenant/site scope", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(
      buildFailurePareto({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "UTC",
        from: "2026-07-01",
        to: "2026-07-31",
        assetId: "asset-other",
        now,
      }),
    ).rejects.toBeInstanceOf(FailureParetoError);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
