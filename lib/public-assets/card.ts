import type { PublicMaintenanceRequestToken } from "@prisma/client";
import { db } from "@/lib/db";

const ASSET_VIEWS_PER_HOUR = 120;
const ASSET_LOOKUP_ACTION = "PUBLIC_ASSET_LOOKUP";

export class PublicAssetCardError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_FOUND" | "RATE_LIMITED",
    message: string,
  ) {
    super(message);
    this.name = "PublicAssetCardError";
  }
}

export async function getPublicAssetCard(input: {
  token: Pick<PublicMaintenanceRequestToken, "id" | "siteId">;
  assetCode: string;
  origin?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const recentCount = await db.auditLog.count({
    where: {
      entityType: "PublicMaintenanceRequestToken",
      entityId: input.token.id,
      action: ASSET_LOOKUP_ACTION,
      createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
    },
  });
  if (recentCount >= ASSET_VIEWS_PER_HOUR) {
    throw new PublicAssetCardError(
      "RATE_LIMITED",
      "This scoped token has reached its hourly asset-card lookup limit",
    );
  }

  const asset = await db.asset.findFirst({
    where: {
      siteId: input.token.siteId,
      code: input.assetCode,
      archivedAt: null,
    },
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

  await db.auditLog.create({
    data: {
      actorId: null,
      entityType: "PublicMaintenanceRequestToken",
      entityId: input.token.id,
      action: ASSET_LOOKUP_ACTION,
      afterJson: JSON.stringify({
        assetCode: input.assetCode,
        found: Boolean(asset),
        origin: input.origin ?? null,
      }),
      createdAt: now,
    },
  });

  if (!asset) {
    throw new PublicAssetCardError(
      "ASSET_NOT_FOUND",
      "Asset is not available in the site bound to this scoped token",
    );
  }

  return asset;
}
