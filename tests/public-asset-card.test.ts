import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditCount: vi.fn(),
  auditCreate: vi.fn(),
  assetFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: { count: mocks.auditCount, create: mocks.auditCreate },
    asset: { findFirst: mocks.assetFindFirst },
  },
}));

import { getPublicAssetCard } from "@/lib/public-assets/card";

const token = { id: "token-asset", siteId: "site-a" };

describe("public asset card service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditCount.mockResolvedValue(0);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.assetFindFirst.mockResolvedValue({
      code: "PUMP-100",
      name: "Transfer pump",
      status: "ACTIVE",
      criticality: "HIGH",
      category: "Pump",
      manufacturer: "Example Manufacturing",
      model: "PX-100",
      updatedAt: new Date("2026-08-07T12:00:00.000Z"),
      location: { code: "AREA-A", name: "Process area" },
    });
  });

  it("binds lookup to the token site and returns only the public projection", async () => {
    const result = await getPublicAssetCard({ token, assetCode: "PUMP-100" });

    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: { siteId: "site-a", code: "PUMP-100", archivedAt: null },
      select: {
        code: true,
        name: true,
        status: true,
        criticality: true,
        category: true,
        manufacturer: true,
        model: true,
        updatedAt: true,
        location: { select: { code: true, name: true } },
      },
    });
    expect(result).not.toHaveProperty("serialNumber");
    expect(result).not.toHaveProperty("description");
  });

  it("audits unsuccessful lookups so enumeration still consumes the rate limit", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(
      getPublicAssetCard({
        token,
        assetCode: "UNKNOWN",
        origin: "https://portal.example.local",
      }),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });

    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "PublicMaintenanceRequestToken",
        entityId: "token-asset",
        action: "PUBLIC_ASSET_LOOKUP",
        afterJson: JSON.stringify({
          assetCode: "UNKNOWN",
          found: false,
          origin: "https://portal.example.local",
        }),
      }),
    });
  });

  it("rate limits before performing an asset lookup", async () => {
    mocks.auditCount.mockResolvedValue(120);

    await expect(getPublicAssetCard({ token, assetCode: "PUMP-100" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(mocks.assetFindFirst).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
