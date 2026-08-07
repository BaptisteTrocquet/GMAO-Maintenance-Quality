import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export class PartMasterError extends Error {
  constructor(
    public readonly code: "PART_NOT_FOUND" | "DUPLICATE_SKU",
    message: string,
  ) {
    super(message);
    this.name = "PartMasterError";
  }
}

export type PartMasterPatch = {
  sku?: string;
  name?: string;
  description?: string | null;
  unit?: string;
  reorderPoint?: number;
  unitCost?: number | null;
  active?: boolean;
};

function partAuditSnapshot(part: {
  organizationId: string;
  sku: string;
  name: string;
  description: string | null;
  unit: string;
  reorderPoint: number;
  unitCost: Prisma.Decimal | null;
  active: boolean;
}) {
  return {
    organizationId: part.organizationId,
    sku: part.sku,
    name: part.name,
    description: part.description,
    unit: part.unit,
    reorderPoint: part.reorderPoint,
    unitCost: part.unitCost?.toString() ?? null,
    active: part.active,
  };
}

function duplicateSku(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function listParts(input: {
  organizationId: string;
  includeInactive?: boolean;
}) {
  return db.part.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.includeInactive ? {} : { active: true }),
    },
    include: {
      assetParts: {
        include: {
          asset: {
            select: { id: true, code: true, name: true, siteId: true },
          },
        },
      },
    },
    orderBy: { sku: "asc" },
  });
}

export async function createPart(input: {
  organizationId: string;
  sku: string;
  name: string;
  description?: string | null;
  unit?: string;
  reorderPoint?: number;
  unitCost?: number | null;
  actorId: string;
}) {
  try {
    return await db.$transaction(async (tx) => {
      const part = await tx.part.create({
        data: {
          organizationId: input.organizationId,
          sku: input.sku,
          name: input.name,
          description: input.description ?? null,
          unit: input.unit ?? "EA",
          reorderPoint: input.reorderPoint ?? 0,
          unitCost: input.unitCost ?? null,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "Part",
          entityId: part.id,
          action: "CREATED",
          afterJson: JSON.stringify(partAuditSnapshot(part)),
        },
      });
      return part;
    });
  } catch (error) {
    if (duplicateSku(error)) {
      throw new PartMasterError("DUPLICATE_SKU", "Part SKU already exists in this organization");
    }
    throw error;
  }
}

export async function updatePart(input: {
  organizationId: string;
  partId: string;
  patch: PartMasterPatch;
  actorId: string;
}) {
  const current = await db.part.findFirst({
    where: { id: input.partId, organizationId: input.organizationId },
  });
  if (!current) throw new PartMasterError("PART_NOT_FOUND", "Part not found");

  try {
    return await db.$transaction(async (tx) => {
      const updated = await tx.part.update({
        where: { id: current.id },
        data: input.patch,
      });

      let action = "UPDATED";
      if (input.patch.active === false && current.active) action = "ARCHIVED";
      if (input.patch.active === true && !current.active) action = "REACTIVATED";

      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "Part",
          entityId: current.id,
          action,
          beforeJson: JSON.stringify(partAuditSnapshot(current)),
          afterJson: JSON.stringify(partAuditSnapshot(updated)),
        },
      });
      return updated;
    });
  } catch (error) {
    if (duplicateSku(error)) {
      throw new PartMasterError("DUPLICATE_SKU", "Part SKU already exists in this organization");
    }
    throw error;
  }
}
