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

import { buildPmCompliance } from "@/lib/analytics/pm-compliance";

describe("PM compliance scheduled occurrence scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([
      { due: BigInt(0), completedOnTime: BigInt(0), completedLate: BigInt(0), openOverdue: BigInt(0) },
    ]);
  });

  it("requires the scheduler PREVENTIVE_GENERATED audit so manual preventive work is excluded", async () => {
    await buildPmCompliance({
      organizationId: "org-a",
      siteId: "site-a",
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
      now: new Date("2026-08-08T10:00:00.000Z"),
    });

    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    const sql = mocks.queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
    const text = sql.strings?.join("?") ?? "";
    expect(text).toContain('FROM "AuditLog" generated');
    expect(text).toContain("generated.\"action\" = 'PREVENTIVE_GENERATED'");
    expect(text).toContain('generated."entityId" = wo."id"');
  });
});
