import { db } from "@/lib/db";

export class HierarchyIntegrityError extends Error {
  constructor(
    public readonly code:
      | "LOCATION_SITE_MISMATCH"
      | "PARENT_ASSET_SITE_MISMATCH"
      | "PARENT_LOCATION_SITE_MISMATCH"
      | "SELF_PARENT"
      | "ASSET_HAS_ACTIVE_CHILDREN",
    message: string,
  ) {
    super(message);
    this.name = "HierarchyIntegrityError";
  }
}

export async function assertAssetHierarchyIntegrity(input: {
  siteId: string;
  assetId?: string;
  locationId?: string | null;
  parentAssetId?: string | null;
}) {
  if (input.assetId && input.parentAssetId === input.assetId) {
    throw new HierarchyIntegrityError("SELF_PARENT", "An asset cannot be its own parent");
  }

  if (input.locationId) {
    const location = await db.location.findFirst({
      where: { id: input.locationId, siteId: input.siteId },
      select: { id: true },
    });
    if (!location) {
      throw new HierarchyIntegrityError(
        "LOCATION_SITE_MISMATCH",
        "Location must belong to the asset site",
      );
    }
  }

  if (input.parentAssetId) {
    const parent = await db.asset.findFirst({
      where: { id: input.parentAssetId, siteId: input.siteId },
      select: { id: true },
    });
    if (!parent) {
      throw new HierarchyIntegrityError(
        "PARENT_ASSET_SITE_MISMATCH",
        "Parent asset must belong to the same site",
      );
    }
  }
}

export async function assertLocationHierarchyIntegrity(input: {
  siteId: string;
  locationId?: string;
  parentId?: string | null;
}) {
  if (input.locationId && input.parentId === input.locationId) {
    throw new HierarchyIntegrityError("SELF_PARENT", "A location cannot be its own parent");
  }

  if (!input.parentId) return;

  const parent = await db.location.findFirst({
    where: { id: input.parentId, siteId: input.siteId },
    select: { id: true },
  });
  if (!parent) {
    throw new HierarchyIntegrityError(
      "PARENT_LOCATION_SITE_MISMATCH",
      "Parent location must belong to the same site",
    );
  }
}
