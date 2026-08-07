import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  assetUpdate: vi.fn(),
  assetCount: vi.fn(),
  auditCreate: vi.fn(),
  hierarchy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    asset: {
      findFirst: mocks.assetFindFirst,
      update: mocks.assetUpdate,
      count: mocks.assetCount,
    },
    auditLog: { create: mocks.auditCreate },
  },
}));

vi.mock("@/lib/assets/hierarchy", async () => {
  const actual = await vi.importActual<typeof import("@/lib/assets/hierarchy")>(
    "@/lib/assets/hierarchy",
  );
  return { ...actual, assertAssetHierarchyIntegrity: mocks.hierarchy };
});

import { archiveAsset, updateAssetLifecycle } from "@/lib/assets/lifecycle";

describe("asset lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates equipment metadata and writes an audit event", async () => {
    const current = {
      id: "asset-1",
      siteId: "site-a",
      name: "Pump 1",
      status: "ACTIVE",
      decommissionedAt: null,
    };
    const updated = {
      ...current,
      manufacturer: "Example Industries",
      model: "PX-100",
      serialNumber: "SYN-001",
      category: "Pump",
    };
    mocks.assetFindFirst.mockResolvedValueOnce(current);
    mocks.assetUpdate.mockResolvedValueOnce(updated);
    mocks.auditCreate.mockResolvedValueOnce({ id: "audit-1" });

    await expect(
      updateAssetLifecycle({
        siteId: "site-a",
        assetId: "asset-1",
        actorId: "user-1",
        manufacturer: "Example Industries",
        model: "PX-100",
        serialNumber: "SYN-001",
        category: "Pump",
      }),
    ).resolves.toEqual(updated);

    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-1",
        entityType: "Asset",
        entityId: "asset-1",
        action: "UPDATED",
      }),
    });
  });

  it("soft-archives an asset without deleting it", async () => {
    const current = {
      id: "asset-1",
      siteId: "site-a",
      status: "ACTIVE",
      archivedAt: null,
    };
    mocks.assetFindFirst.mockResolvedValueOnce(current);
    mocks.assetCount.mockResolvedValueOnce(0);
    mocks.assetUpdate.mockResolvedValueOnce({
      ...current,
      status: "DECOMMISSIONED",
      archivedAt: new Date("2026-08-07T12:00:00.000Z"),
    });
    mocks.auditCreate.mockResolvedValueOnce({ id: "audit-2" });

    const result = await archiveAsset({ siteId: "site-a", assetId: "asset-1", actorId: "user-1" });

    expect(result?.status).toBe("DECOMMISSIONED");
    expect(mocks.assetUpdate).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        status: "DECOMMISSIONED",
        decommissionedAt: expect.any(Date),
      }),
    });
  });

  it("refuses to archive an assembly with active child assets", async () => {
    mocks.assetFindFirst.mockResolvedValueOnce({
      id: "asset-parent",
      siteId: "site-a",
      archivedAt: null,
    });
    mocks.assetCount.mockResolvedValueOnce(2);

    await expect(
      archiveAsset({ siteId: "site-a", assetId: "asset-parent" }),
    ).rejects.toMatchObject({ code: "ASSET_HAS_ACTIVE_CHILDREN" });
    expect(mocks.assetUpdate).not.toHaveBeenCalled();
  });
});
