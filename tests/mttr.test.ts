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

import { buildMttr, calculateMttr, MttrError } from "@/lib/analytics/mttr";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-08-01T00:00:00.000Z");
const now = new Date("2026-08-08T10:00:00.000Z");

describe("MTTR analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.queryRaw.mockResolvedValue([
      {
        completedCorrective: BigInt(5),
        validRepairs: BigInt(4),
        incompleteRepairs: BigInt(1),
        totalRepairMinutes: "600",
      },
    ]);
  });

  it("calculates MTTR from total valid repair minutes divided by valid repair count", () => {
    const result = calculateMttr(
      { completedCorrective: 5, validRepairs: 4, incompleteRepairs: 1, totalRepairMinutes: 600 },
      { from, to, generatedAt: now },
    );

    expect(result.mttrMinutes).toBe(150);
    expect(result.mttrHours).toBe(2.5);
    expect(result.empty).toBe(false);
    expect(result.insufficientData).toBe(false);
  });

  it("distinguishes no completed corrective work from completed work with unusable timestamps", () => {
    const empty = calculateMttr(
      { completedCorrective: 0, validRepairs: 0, incompleteRepairs: 0, totalRepairMinutes: 0 },
      { from, to, generatedAt: now },
    );
    const incomplete = calculateMttr(
      { completedCorrective: 2, validRepairs: 0, incompleteRepairs: 2, totalRepairMinutes: 0 },
      { from, to, generatedAt: now },
    );

    expect(empty).toMatchObject({ mttrMinutes: null, empty: true, insufficientData: true });
    expect(incomplete).toMatchObject({ mttrMinutes: null, empty: false, insufficientData: true });
  });

  it("converts aggregate bigint/string values without changing the formula", async () => {
    const result = await buildMttr({ organizationId: "org-a", siteId: "site-a", from, to, now });

    expect(result).toMatchObject({
      completedCorrective: 5,
      validRepairs: 4,
      incompleteRepairs: 1,
      totalRepairMinutes: 600,
      mttrMinutes: 150,
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("caps future reporting windows at now and returns empty without querying for fully future windows", async () => {
    const capped = await buildMttr({
      organizationId: "org-a",
      siteId: "site-a",
      from,
      to: new Date("2026-09-01T00:00:00.000Z"),
      now,
    });
    expect(capped.to).toBe(now.toISOString());

    mocks.queryRaw.mockClear();
    const future = await buildMttr({
      organizationId: "org-a",
      siteId: "site-a",
      from: new Date("2026-08-10T00:00:00.000Z"),
      to: new Date("2026-08-20T00:00:00.000Z"),
      now,
    });
    expect(future.empty).toBe(true);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("validates optional assets in the active tenant/site", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);
    await expect(
      buildMttr({ organizationId: "org-a", siteId: "site-a", assetId: "asset-other", from, to, now }),
    ).rejects.toMatchObject({ code: "ASSET_SCOPE_MISMATCH" });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("rejects inverted date ranges before database work", async () => {
    await expect(
      buildMttr({ organizationId: "org-a", siteId: "site-a", from: to, to: from, now }),
    ).rejects.toBeInstanceOf(MttrError);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
