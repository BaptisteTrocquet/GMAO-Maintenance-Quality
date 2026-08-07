import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export class InventoryLocationError extends Error {
  constructor(
    public readonly code:
      | "SITE_NOT_FOUND"
      | "WAREHOUSE_NOT_FOUND"
      | "BIN_NOT_FOUND"
      | "DUPLICATE_WAREHOUSE_CODE"
      | "DUPLICATE_BIN_CODE",
    message: string,
  ) {
    super(message);
    this.name = "InventoryLocationError";
  }
}

function uniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function requireSite(organizationId: string, siteId: string) {
  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true, organization: { active: true } },
    select: { id: true },
  });
  if (!site) throw new InventoryLocationError("SITE_NOT_FOUND", "Active site not found");
  return site;
}

export async function listWarehouses(input: {
  organizationId: string;
  siteId: string;
  includeInactive?: boolean;
}) {
  await requireSite(input.organizationId, input.siteId);
  return db.warehouse.findMany({
    where: {
      siteId: input.siteId,
      ...(input.includeInactive ? {} : { active: true }),
    },
    include: {
      bins: {
        where: input.includeInactive ? {} : { active: true },
        orderBy: { code: "asc" },
      },
    },
    orderBy: { code: "asc" },
  });
}

export async function createWarehouse(input: {
  organizationId: string;
  siteId: string;
  code: string;
  name: string;
  description?: string | null;
  actorId: string;
}) {
  await requireSite(input.organizationId, input.siteId);
  try {
    return await db.$transaction(async (tx) => {
      const warehouse = await tx.warehouse.create({
        data: {
          siteId: input.siteId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "Warehouse",
          entityId: warehouse.id,
          action: "CREATED",
          afterJson: JSON.stringify({
            organizationId: input.organizationId,
            siteId: warehouse.siteId,
            code: warehouse.code,
            name: warehouse.name,
            description: warehouse.description,
            active: warehouse.active,
          }),
        },
      });
      return warehouse;
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new InventoryLocationError(
        "DUPLICATE_WAREHOUSE_CODE",
        "Warehouse code already exists in this site",
      );
    }
    throw error;
  }
}

export async function updateWarehouse(input: {
  organizationId: string;
  siteId: string;
  warehouseId: string;
  patch: {
    code?: string;
    name?: string;
    description?: string | null;
    active?: boolean;
  };
  actorId: string;
}) {
  await requireSite(input.organizationId, input.siteId);
  const current = await db.warehouse.findFirst({
    where: { id: input.warehouseId, siteId: input.siteId },
  });
  if (!current) throw new InventoryLocationError("WAREHOUSE_NOT_FOUND", "Warehouse not found");

  try {
    return await db.$transaction(async (tx) => {
      const warehouse = await tx.warehouse.update({
        where: { id: current.id },
        data: input.patch,
      });
      const action =
        input.patch.active === false && current.active
          ? "ARCHIVED"
          : input.patch.active === true && !current.active
            ? "REACTIVATED"
            : "UPDATED";
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "Warehouse",
          entityId: current.id,
          action,
          beforeJson: JSON.stringify(current),
          afterJson: JSON.stringify(warehouse),
        },
      });
      return warehouse;
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new InventoryLocationError(
        "DUPLICATE_WAREHOUSE_CODE",
        "Warehouse code already exists in this site",
      );
    }
    throw error;
  }
}

export async function createStockBin(input: {
  organizationId: string;
  siteId: string;
  warehouseId: string;
  code: string;
  name: string;
  description?: string | null;
  actorId: string;
}) {
  await requireSite(input.organizationId, input.siteId);
  const warehouse = await db.warehouse.findFirst({
    where: { id: input.warehouseId, siteId: input.siteId },
    select: { id: true, active: true },
  });
  if (!warehouse) throw new InventoryLocationError("WAREHOUSE_NOT_FOUND", "Warehouse not found");
  if (!warehouse.active) {
    throw new InventoryLocationError("WAREHOUSE_NOT_FOUND", "Warehouse is inactive");
  }

  try {
    return await db.$transaction(async (tx) => {
      const bin = await tx.stockBin.create({
        data: {
          warehouseId: warehouse.id,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "StockBin",
          entityId: bin.id,
          action: "CREATED",
          afterJson: JSON.stringify({
            organizationId: input.organizationId,
            siteId: input.siteId,
            warehouseId: bin.warehouseId,
            code: bin.code,
            name: bin.name,
            description: bin.description,
            active: bin.active,
          }),
        },
      });
      return bin;
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new InventoryLocationError(
        "DUPLICATE_BIN_CODE",
        "Bin code already exists in this warehouse",
      );
    }
    throw error;
  }
}

export async function updateStockBin(input: {
  organizationId: string;
  siteId: string;
  warehouseId: string;
  binId: string;
  patch: {
    code?: string;
    name?: string;
    description?: string | null;
    active?: boolean;
  };
  actorId: string;
}) {
  await requireSite(input.organizationId, input.siteId);
  const current = await db.stockBin.findFirst({
    where: {
      id: input.binId,
      warehouseId: input.warehouseId,
      warehouse: { siteId: input.siteId },
    },
  });
  if (!current) throw new InventoryLocationError("BIN_NOT_FOUND", "Stock bin not found");

  try {
    return await db.$transaction(async (tx) => {
      const bin = await tx.stockBin.update({ where: { id: current.id }, data: input.patch });
      const action =
        input.patch.active === false && current.active
          ? "ARCHIVED"
          : input.patch.active === true && !current.active
            ? "REACTIVATED"
            : "UPDATED";
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "StockBin",
          entityId: current.id,
          action,
          beforeJson: JSON.stringify(current),
          afterJson: JSON.stringify(bin),
        },
      });
      return bin;
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new InventoryLocationError(
        "DUPLICATE_BIN_CODE",
        "Bin code already exists in this warehouse",
      );
    }
    throw error;
  }
}
