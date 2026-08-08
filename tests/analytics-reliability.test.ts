import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: mocks.queryRaw },
}));

import { averageHours, buildReliabilityDashboard } from "@/lib/analytics/reliability";

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

  it("calculates average hours from aggregate seconds without relying on database floating averages", () => {
    expect(averageHours(10800, 2)).toBe(1.5);
    expect(averageHours(BigInt(7200), BigInt(2))).toBe(1);
    expect(averageHours(0, 0)).toBeNull();
    expect(averageHours(-1, 1)).toBeNull();
  });

  it("maps MTTR samples, excluded incomplete rows and MTBF proxy intervals", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 2, excludedIncomplete: 1, totalSeconds: 10800 }])
      .mockResolvedValueOnce([{ intervalCount: 3, assetCount: 2, totalSeconds: 43200 }]);

    const result = await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      now: new Date("2026-08-08T08:00:00.000Z"),
    });

    expect(result.mttr).toEqual({ hours: 1.5, sampleCount: 2, excludedIncomplete: 1 });
    expect(result.mtbfProxy).toEqual({ hours: 4, sampleCount: 3, assetCount: 2 });
    expect(result.definitions.mtbfProxy).toMatch(/proxy/i);
  });

  it("defines MTTR from valid completed corrective repair durations and counts excluded rows", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 0, excludedIncomplete: 0, totalSeconds: 0 }])
      .mockResolvedValueOnce([{ intervalCount: 0, assetCount: 0, totalSeconds: 0 }]);

    await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      now: new Date("2026-08-08T08:00:00.000Z"),
    });

    const query = sqlText(0);
    expect(query).toContain('"completedAt" - "startedAt"');
    expect(query).toContain("wo.type = 'CORRECTIVE'");
    expect(query).toContain("wo.status = 'COMPLETED'");
    expect(query).toContain('"startedAt" >= "requestedAt"');
    expect(query).toContain('"completedAt" >= "startedAt"');
    expect(query).toContain('"excludedIncomplete"');
    expect(query).toContain('site."organizationId"');
    expect(query).toContain('wo."siteId"');
  });

  it("defines MTBF proxy from successive non-cancelled corrective request events on the same asset", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 0, excludedIncomplete: 0, totalSeconds: 0 }])
      .mockResolvedValueOnce([{ intervalCount: 0, assetCount: 0, totalSeconds: 0 }]);

    await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      now: new Date("2026-08-08T08:00:00.000Z"),
    });

    const query = sqlText(1);
    expect(query).toContain('LAG(wo."requestedAt")');
    expect(query).toContain('PARTITION BY wo."assetId"');
    expect(query).toContain("wo.type = 'CORRECTIVE'");
    expect(query).toContain("wo.status <> 'CANCELLED'");
    expect(query).toContain('wo."assetId" IS NOT NULL');
    expect(query).toContain('"requestedAt" > "previousRequestedAt"');
  });

  it("uses null rather than zero when no valid reliability sample exists", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ sampleCount: 0, excludedIncomplete: 2, totalSeconds: 0 }])
      .mockResolvedValueOnce([{ intervalCount: 0, assetCount: 0, totalSeconds: 0 }]);

    const result = await buildReliabilityDashboard({
      organizationId: "org-a",
      siteId: "site-a",
    });

    expect(result.mttr).toEqual({ hours: null, sampleCount: 0, excludedIncomplete: 2 });
    expect(result.mtbfProxy).toEqual({ hours: null, sampleCount: 0, assetCount: 0 });
  });

  it("supports bigint aggregate values returned by PostgreSQL drivers", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([
        { sampleCount: BigInt(2), excludedIncomplete: BigInt(1), totalSeconds: BigInt(7200) },
      ])
      .mockResolvedValueOnce([
        { intervalCount: BigInt(2), assetCount: BigInt(1), totalSeconds: BigInt(14400) },
      ]);

    const result = await buildReliabilityDashboard({ organizationId: "org-a", siteId: "site-a" });

    expect(result.mttr.hours).toBe(1);
    expect(result.mttr.sampleCount).toBe(2);
    expect(result.mtbfProxy.hours).toBe(2);
    expect(result.mtbfProxy.assetCount).toBe(1);
  });
});
