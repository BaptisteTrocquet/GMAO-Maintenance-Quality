import { db } from "@/lib/db";
import {
  assertAssetHierarchyIntegrity,
  HierarchyIntegrityError,
} from "@/lib/assets/hierarchy";

export type AssetLifecycleInput = {
  siteId: string;
  assetId: string;
  actorId?: string | null;
  locationId?: string | null;
  parentAssetId?: string | null;
  code?: string;
  name?: string;
  description?: string | null;
  category?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  status?: "ACTIVE" | "INACTIVE" | "OUT_OF_SERVICE" | "DECOMMISSIONED";
  statusNote?: string | null;
  criticality?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  installedAt?: Date | null;
  commissionedAt?: Date | null;
  decommissionedAt?: Date | null;
};

function snapshot(asset: Record<string, unknown>) {
  return JSON.stringify(asset);
}

export async function updateAssetLifecycle(input: AssetLifecycleInput) {
  const current = await db.asset.findFirst({
    where: { id: input.assetId, siteId: input.siteId, archivedAt: null },
  });
  if (!current) return null;

  if (input.locationId !== undefined || input.parentAssetId !== undefined) {
    await assertAssetHierarchyIntegrity({
      siteId: input.siteId,
      assetId: input.assetId,
      locationId: input.locationId,
      parentAssetId: input.parentAssetId,
    });
  }

  if (
    input.status === "DECOMMISSIONED" &&
    input.decommissionedAt === undefined &&
    !current.decommissionedAt
  ) {
    input.decommissionedAt = new Date();
  }

  const updated = await db.asset.update({
    where: { id: input.assetId },
    data: {
      ...(input.locationId === undefined ? {} : { locationId: input.locationId }),
      ...(input.parentAssetId === undefined ? {} : { parentAssetId: input.parentAssetId }),
      ...(input.code === undefined ? {} : { code: input.code }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.manufacturer === undefined ? {} : { manufacturer: input.manufacturer }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.serialNumber === undefined ? {} : { serialNumber: input.serialNumber }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.criticality === undefined ? {} : { criticality: input.criticality }),
      ...(input.installedAt === undefined ? {} : { installedAt: input.installedAt }),
      ...(input.commissionedAt === undefined ? {} : { commissionedAt: input.commissionedAt }),
      ...(input.decommissionedAt === undefined
        ? {}
        : { decommissionedAt: input.decommissionedAt }),
    },
  });

  if (input.status !== undefined && input.status !== current.status) {
    await db.assetStatusHistory.create({
      data: {
        assetId: updated.id,
        fromStatus: current.status,
        toStatus: input.status,
        note: input.statusNote ?? null,
      },
    });
  }

  await db.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      entityType: "Asset",
      entityId: updated.id,
      action: "UPDATED",
      beforeJson: snapshot(current),
      afterJson: snapshot(updated),
    },
  });

  return updated;
}

export async function archiveAsset(input: {
  siteId: string;
  assetId: string;
  actorId?: string | null;
}) {
  const current = await db.asset.findFirst({
    where: { id: input.assetId, siteId: input.siteId, archivedAt: null },
  });
  if (!current) return null;

  const activeChildren = await db.asset.count({
    where: { parentAssetId: input.assetId, archivedAt: null },
  });
  if (activeChildren > 0) {
    throw new HierarchyIntegrityError(
      "ASSET_HAS_ACTIVE_CHILDREN",
      "Archive or re-parent child assets before archiving this asset",
    );
  }

  const archived = await db.asset.update({
    where: { id: input.assetId },
    data: { archivedAt: new Date(), status: "DECOMMISSIONED", decommissionedAt: new Date() },
  });

  if (current.status !== "DECOMMISSIONED") {
    await db.assetStatusHistory.create({
      data: {
        assetId: archived.id,
        fromStatus: current.status,
        toStatus: "DECOMMISSIONED",
        note: "Asset archived",
      },
    });
  }

  await db.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      entityType: "Asset",
      entityId: archived.id,
      action: "ARCHIVED",
      beforeJson: snapshot(current),
      afterJson: snapshot(archived),
    },
  });

  return archived;
}
