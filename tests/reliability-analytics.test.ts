import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: mocks.queryRaw },
}));

import { buildReliabilityDashboard } from "@/lib/analytics/reliability";

const input = {
  organizationId: "org-a",
  siteId: "site-a",
  now: new Date("2026-08-08T10:00:00.000Z"),
};

describe("reliability analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns MTTR and corrective-event interval averages with explicit sample sizes", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 8, hours: 5.25 }])
      .mockResolvedValueOnce([{ intervalCount: 6, assetCount: 3, hours: 120 }]);

    const result = await buildReliabilityDashboard(input);

    expect(result.generatedAt).toBe(input.now.toISOString());
    expect(result.mttr).toEqual({ hours: 5.25, sampleCount: 8 });
    expect(result.mtbfProxy).toEqual({ hours: 120, sampleCount: 6, assetCount: 3 });
    expect(result.definitions.mttr).toContain("startedAt");
    expect(result.definitions.mtbfProxy).toContain("proxy");
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("returns null rather than zero when there is not enough valid history", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 0, hours: null }])
      .mockResolvedValueOnce([{ intervalCount: 0, assetCount: 0, hours: null }]);

    const result = await buildReliabilityDashboard(input);

    expect(result.mttr).toEqual({ hours: null, sampleCount: 0 });
    expect(result.mtbfProxy).toEqual({ hours: null, sampleCount: 0, assetCount: 0 });
  });

  it("normalizes non-finite database values to missing data instead of publishing invalid KPIs", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 1, hours: Number.NaN }])
      .mockResolvedValueOnce([{ intervalCount: 1, assetCount: 1, hours: Number.POSITIVE_INFINITY }]);

    const result = await buildReliabilityDashboard(input);

    expect(result.mttr.hours).toBeNull();
    expect(result.mtbfProxy.hours).toBeNull();
  });

  it("uses safe empty defaults if an aggregate unexpectedly returns no row", async () => {
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await buildReliabilityDashboard(input);

    expect(result.mttr).toEqual({ hours: null, sampleCount: 0 });
    expect(result.mtbfProxy).toEqual({ hours: null, sampleCount: 0, assetCount: 0 });
  });
});
