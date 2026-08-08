import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: mocks.queryRaw },
}));

import { buildReliabilityDashboard } from "@/lib/analytics/reliability";

function sqlText(callIndex: number) {
  const query = mocks.queryRaw.mock.calls[callIndex]?.[0] as
    | { sql?: string; text?: string; strings?: string[] }
    | undefined;
  return query?.sql ?? query?.text ?? query?.strings?.join("?") ?? "";
}

describe("reliability analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns database-native MTTR and MTBF proxy samples", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 4, hours: 6.5 }])
      .mockResolvedValueOnce([{ intervalCount: 7, assetCount: 3, hours: 120 }]);

    const result = await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      now: new Date("2026-08-08T08:00:00.000Z"),
    });

    expect(result.mttr).toEqual({ hours: 6.5, sampleCount: 4 });
    expect(result.mtbfProxy).toEqual({ hours: 120, sampleCount: 7, assetCount: 3 });
    expect(result.definitions.mtbfProxy).toMatch(/proxy/i);
  });

  it("defines MTTR from valid completed corrective repair durations", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 0, hours: null }])
      .mockResolvedValueOnce([{ intervalCount: 0, assetCount: 0, hours: null }]);

    await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      now: new Date("2026-08-08T08:00:00.000Z"),
    });

    const query = sqlText(0);
    expect(query).toContain('wo."completedAt" - wo."startedAt"');
    expect(query).toContain("wo.type = 'CORRECTIVE'");
    expect(query).toContain("wo.status = 'COMPLETED'");
    expect(query).toContain('wo."completedAt" >= wo."startedAt"');
    expect(query).toContain('site."organizationId"');
    expect(query).toContain('wo."siteId"');
  });

  it("defines MTBF proxy from successive corrective request events on the same asset", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 0, hours: null }])
      .mockResolvedValueOnce([{ intervalCount: 0, assetCount: 0, hours: null }]);

    await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      now: new Date("2026-08-08T08:00:00.000Z"),
    });

    const query = sqlText(1);
    expect(query).toContain('LAG(wo."requestedAt")');
    expect(query).toContain('PARTITION BY wo."assetId"');
    expect(query).toContain('wo."assetId" IS NOT NULL');
    expect(query).toContain('"requestedAt" > "previousRequestedAt"');
  });

  it("uses null rather than zero when no valid reliability sample exists", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 0, hours: null }])
      .mockResolvedValueOnce([{ intervalCount: 0, assetCount: 0, hours: null }]);

    const result = await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
    });

    expect(result.mttr).toEqual({ hours: null, sampleCount: 0 });
    expect(result.mtbfProxy).toEqual({ hours: null, sampleCount: 0, assetCount: 0 });
  });

  it("fails closed to null for non-finite aggregate values", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 2, hours: Number.NaN }])
      .mockResolvedValueOnce([{ intervalCount: 1, assetCount: 1, hours: Number.POSITIVE_INFINITY }]);

    const result = await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
    });

    expect(result.mttr.hours).toBeNull();
    expect(result.mtbfProxy.hours).toBeNull();
  });
});
