import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  locationFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    location: { findFirst: mocks.locationFindFirst },
    asset: { findFirst: mocks.assetFindFirst },
  },
}));

import {
  assertAssetHierarchyIntegrity,
  assertLocationHierarchyIntegrity,
} from "@/lib/assets/hierarchy";

describe("hierarchy integrity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects asset locations from another site", async () => {
    mocks.locationFindFirst.mockResolvedValueOnce(null);

    await expect(
      assertAssetHierarchyIntegrity({ siteId: "site-a", locationId: "location-b" }),
    ).rejects.toMatchObject({ code: "LOCATION_SITE_MISMATCH" });
  });

  it("rejects parent assets from another site", async () => {
    mocks.assetFindFirst.mockResolvedValueOnce(null);

    await expect(
      assertAssetHierarchyIntegrity({ siteId: "site-a", parentAssetId: "asset-b" }),
    ).rejects.toMatchObject({ code: "PARENT_ASSET_SITE_MISMATCH" });
  });

  it("accepts asset relationships within the same site", async () => {
    mocks.locationFindFirst.mockResolvedValueOnce({ id: "location-a" });
    mocks.assetFindFirst.mockResolvedValueOnce({ id: "asset-parent" });

    await expect(
      assertAssetHierarchyIntegrity({
        siteId: "site-a",
        locationId: "location-a",
        parentAssetId: "asset-parent",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects location parents from another site", async () => {
    mocks.locationFindFirst.mockResolvedValueOnce(null);

    await expect(
      assertLocationHierarchyIntegrity({ siteId: "site-a", parentId: "location-b" }),
    ).rejects.toMatchObject({ code: "PARENT_LOCATION_SITE_MISMATCH" });
  });

  it("rejects self-parenting", async () => {
    await expect(
      assertAssetHierarchyIntegrity({
        siteId: "site-a",
        assetId: "asset-a",
        parentAssetId: "asset-a",
      }),
    ).rejects.toMatchObject({ code: "SELF_PARENT" });

    await expect(
      assertLocationHierarchyIntegrity({
        siteId: "site-a",
        locationId: "location-a",
        parentId: "location-a",
      }),
    ).rejects.toMatchObject({ code: "SELF_PARENT" });
  });
});
