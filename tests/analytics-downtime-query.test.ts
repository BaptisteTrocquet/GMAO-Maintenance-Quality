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
  buildDowntimeDashboard,
  DOWNTIME_TOP_ASSET_LIMIT,
} from "@/lib/analytics/downtime";

function sqlText(callIndex: number) {
  const query = mocks.queryRaw.mock.calls[callIndex]?.[0] as
    | { sql?: string; text?: string }
    | undefined;
  return query?.sql ?? query?.text ?? "";
}

describe("downtime analytics query bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  });

  it("aggregates in SQL by site-local month and limits the asset ranking", async () => {
    await buildDowntimeDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-01-01",
      to: "2026-03-31",
      now: new Date("2026-04-01T12:00:00.000Z"),
    });

    expect(sqlText(0)).toContain("TO_CHAR");
    expect(sqlText(0)).toContain("wo.status = 'COMPLETED'");
    expect(sqlText(0)).toContain('wo."downtimeMinutes" > 0');
    expect(sqlText(1)).toContain('INNER JOIN "Asset" asset');
    expect(sqlText(1)).toContain("ORDER BY minutes DESC");
    expect(DOWNTIME_TOP_ASSET_LIMIT).toBe(10);
  });

  it("rejects reporting windows beyond the bounded two-year horizon before SQL", async () => {
    await expect(
      buildDowntimeDashboard({
        organizationId: "org-a",
        siteId: "site-a",
        timeZone: "UTC",
        from: "2023-01-01",
        to: "2026-03-31",
        now: new Date("2026-04-01T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "RANGE_TOO_LARGE" });

    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
