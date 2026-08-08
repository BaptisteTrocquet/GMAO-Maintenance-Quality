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
  buildPmCompliance,
  calculatePmCompliance,
  PmComplianceError,
} from "@/lib/analytics/pm-compliance";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-08-01T00:00:00.000Z");
const now = new Date("2026-08-08T10:00:00.000Z");

describe("PM compliance analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.queryRaw.mockResolvedValue([
      {
        due: BigInt(10),
        completedOnTime: BigInt(7),
        completedLate: BigInt(2),
        openOverdue: BigInt(1),
      },
    ]);
  });

  it("calculates compliance from on-time completions over all due PM work", () => {
    const result = calculatePmCompliance(
      { due: 10, completedOnTime: 7, completedLate: 2, openOverdue: 1 },
      { from, to, generatedAt: now },
    );

    expect(result.complianceRate).toBe(70);
    expect(result.missed).toBe(3);
    expect(result.empty).toBe(false);
  });

  it("returns null rather than a misleading 100% when no PM work was due", () => {
    const result = calculatePmCompliance(
      { due: 0, completedOnTime: 0, completedLate: 0, openOverdue: 0 },
      { from, to, generatedAt: now },
    );

    expect(result.complianceRate).toBeNull();
    expect(result.empty).toBe(true);
  });

  it("caps the reporting denominator at now so future PM due dates are excluded", async () => {
    const futureTo = new Date("2026-09-01T00:00:00.000Z");
    const result = await buildPmCompliance({
      organizationId: "org-a",
      siteId: "site-a",
      from,
      to: futureTo,
      now,
    });

    expect(result.to).toBe(now.toISOString());
    expect(result.due).toBe(10);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns an empty result without querying when the full requested window is future", async () => {
    const result = await buildPmCompliance({
      organizationId: "org-a",
      siteId: "site-a",
      from: new Date("2026-08-10T00:00:00.000Z"),
      to: new Date("2026-08-20T00:00:00.000Z"),
      now,
    });

    expect(result.empty).toBe(true);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("validates an optional asset belongs to the requested active tenant/site", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(
      buildPmCompliance({
        organizationId: "org-a",
        siteId: "site-a",
        assetId: "asset-other",
        from,
        to,
        now,
      }),
    ).rejects.toBeInstanceOf(PmComplianceError);

    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: {
        id: "asset-other",
        siteId: "site-a",
        archivedAt: null,
        site: { organizationId: "org-a", active: true },
      },
      select: { id: true },
    });
  });

  it("rejects inverted date ranges before touching the database", async () => {
    await expect(
      buildPmCompliance({
        organizationId: "org-a",
        siteId: "site-a",
        from: to,
        to: from,
        now,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DATE_RANGE" });

    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
