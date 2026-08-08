import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export class SupplierReferenceError extends Error {
  constructor(
    public readonly code:
      | "SUPPLIER_NOT_FOUND"
      | "PART_NOT_FOUND"
      | "DUPLICATE_SUPPLIER_CODE"
      | "REFERENCE_NOT_FOUND"
      | "CROSS_ORGANIZATION_REFERENCE",
    message: string,
  ) {
    super(message);
    this.name = "SupplierReferenceError";
  }
}

function uniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function supplierSnapshot(supplier: {
  organizationId: string;
  code: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  active: boolean;
}) {
  return {
    organizationId: supplier.organizationId,
    code: supplier.code,
    name: supplier.name,
    contactName: supplier.contactName,
    email: supplier.email,
    phone: supplier.phone,
    website: supplier.website,
    active: supplier.active,
  };
}

function referenceSnapshot(reference: {
  partId: string;
  supplierId: string;
  supplierPartNumber: string;
  preferred: boolean;
  leadTimeDays: number | null;
  minOrderQuantity: number | null;
  unitCost: Prisma.Decimal | null;
  currency: string;
  active: boolean;
}) {
  return {
    partId: reference.partId,
    supplierId: reference.supplierId,
    supplierPartNumber: reference.supplierPartNumber,
    preferred: reference.preferred,
    leadTimeDays: reference.leadTimeDays,
    minOrderQuantity: reference.minOrderQuantity,
    unitCost: reference.unitCost?.toString() ?? null,
    currency: reference.currency,
    active: reference.active,
  };
}

function optionalNullable<T>(value: T | null | undefined, previous: T | null | undefined) {
  return value === undefined ? (previous ?? null) : value;
}

async function requirePartSupplierScope(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; partId: string; supplierId: string },
) {
  const [part, supplier] = await Promise.all([
    tx.part.findFirst({
      where: { id: input.partId, organizationId: input.organizationId },
      select: { id: true },
    }),
    tx.supplier.findFirst({
      where: { id: input.supplierId, organizationId: input.organizationId },
      select: { id: true, active: true },
    }),
  ]);
  if (!part) throw new SupplierReferenceError("PART_NOT_FOUND", "Part not found in organization scope");
  if (!supplier) {
    const supplierOutsideScope = await tx.supplier.findUnique({
      where: { id: input.supplierId },
      select: { organizationId: true },
    });
    if (supplierOutsideScope) {
      throw new SupplierReferenceError(
        "CROSS_ORGANIZATION_REFERENCE",
        "Supplier and part must belong to the same organization",
      );
    }
    throw new SupplierReferenceError("SUPPLIER_NOT_FOUND", "Supplier not found in organization scope");
  }
  if (!supplier.active) {
    throw new SupplierReferenceError("SUPPLIER_NOT_FOUND", "Supplier is inactive");
  }
}

export async function listSuppliers(input: {
  organizationId: string;
  includeInactive?: boolean;
}) {
  return db.supplier.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.includeInactive ? {} : { active: true }),
    },
    include: {
      _count: { select: { partReferences: true } },
    },
    orderBy: [{ name: "asc" }, { code: "asc" }],
  });
}

export async function createSupplier(input: {
  organizationId: string;
  code: string;
  name: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  actorId: string;
}) {
  try {
    return await db.$transaction(async (tx) => {
      const supplier = await tx.supplier.create({
        data: {
          organizationId: input.organizationId,
          code: input.code,
          name: input.name,
          contactName: input.contactName ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          website: input.website ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "Supplier",
          entityId: supplier.id,
          action: "CREATED",
          afterJson: JSON.stringify(supplierSnapshot(supplier)),
        },
      });
      return supplier;
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new SupplierReferenceError(
        "DUPLICATE_SUPPLIER_CODE",
        "Supplier code already exists in this organization",
      );
    }
    throw error;
  }
}

export async function updateSupplier(input: {
  organizationId: string;
  supplierId: string;
  patch: {
    code?: string;
    name?: string;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    active?: boolean;
  };
  actorId: string;
}) {
  const current = await db.supplier.findFirst({
    where: { id: input.supplierId, organizationId: input.organizationId },
  });
  if (!current) {
    throw new SupplierReferenceError("SUPPLIER_NOT_FOUND", "Supplier not found in organization scope");
  }

  try {
    return await db.$transaction(async (tx) => {
      const supplier = await tx.supplier.update({
        where: { id: current.id },
        data: input.patch,
      });

      if (input.patch.active === false && current.active) {
        await tx.partSupplier.updateMany({
          where: { supplierId: current.id, active: true },
          data: { active: false, preferred: false },
        });
      }

      const action =
        input.patch.active === false && current.active
          ? "ARCHIVED"
          : input.patch.active === true && !current.active
            ? "REACTIVATED"
            : "UPDATED";
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "Supplier",
          entityId: current.id,
          action,
          beforeJson: JSON.stringify(supplierSnapshot(current)),
          afterJson: JSON.stringify(supplierSnapshot(supplier)),
        },
      });
      return supplier;
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new SupplierReferenceError(
        "DUPLICATE_SUPPLIER_CODE",
        "Supplier code already exists in this organization",
      );
    }
    throw error;
  }
}

export async function listPartSuppliers(input: {
  organizationId: string;
  partId: string;
  includeInactive?: boolean;
}) {
  const part = await db.part.findFirst({
    where: { id: input.partId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!part) throw new SupplierReferenceError("PART_NOT_FOUND", "Part not found in organization scope");

  return db.partSupplier.findMany({
    where: {
      partId: input.partId,
      supplier: { organizationId: input.organizationId },
      ...(input.includeInactive ? {} : { active: true, supplier: { organizationId: input.organizationId, active: true } }),
    },
    include: { supplier: true },
    orderBy: [{ preferred: "desc" }, { supplier: { name: "asc" } }],
  });
}

export async function setPartSupplierReference(input: {
  organizationId: string;
  partId: string;
  supplierId: string;
  supplierPartNumber: string;
  preferred?: boolean;
  leadTimeDays?: number | null;
  minOrderQuantity?: number | null;
  unitCost?: number | null;
  currency?: string;
  active?: boolean;
  actorId: string;
}) {
  return db.$transaction(async (tx) => {
    await requirePartSupplierScope(tx, input);
    const previous = await tx.partSupplier.findUnique({
      where: { partId_supplierId: { partId: input.partId, supplierId: input.supplierId } },
    });

    const preferred = input.preferred ?? previous?.preferred ?? false;
    const active = input.active ?? previous?.active ?? true;
    if (preferred && active) {
      await tx.partSupplier.updateMany({
        where: {
          partId: input.partId,
          preferred: true,
          active: true,
          NOT: { supplierId: input.supplierId },
        },
        data: { preferred: false },
      });
    }

    const reference = await tx.partSupplier.upsert({
      where: { partId_supplierId: { partId: input.partId, supplierId: input.supplierId } },
      create: {
        partId: input.partId,
        supplierId: input.supplierId,
        supplierPartNumber: input.supplierPartNumber,
        preferred: preferred && active,
        leadTimeDays: input.leadTimeDays ?? null,
        minOrderQuantity: input.minOrderQuantity ?? null,
        unitCost: input.unitCost ?? null,
        currency: input.currency ?? "EUR",
        active,
      },
      update: {
        supplierPartNumber: input.supplierPartNumber,
        preferred: preferred && active,
        leadTimeDays: optionalNullable(input.leadTimeDays, previous?.leadTimeDays),
        minOrderQuantity: optionalNullable(input.minOrderQuantity, previous?.minOrderQuantity),
        unitCost: optionalNullable(input.unitCost, previous?.unitCost ? Number(previous.unitCost) : null),
        currency: input.currency ?? previous?.currency ?? "EUR",
        active,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: "PartSupplier",
        entityId: `${input.partId}:${input.supplierId}`,
        action: previous ? "UPDATED" : "CREATED",
        beforeJson: previous ? JSON.stringify(referenceSnapshot(previous)) : null,
        afterJson: JSON.stringify(referenceSnapshot(reference)),
      },
    });
    return reference;
  });
}

export async function disablePartSupplierReference(input: {
  organizationId: string;
  partId: string;
  supplierId: string;
  actorId: string;
}) {
  return db.$transaction(async (tx) => {
    await requirePartSupplierScope(tx, input);
    const current = await tx.partSupplier.findUnique({
      where: { partId_supplierId: { partId: input.partId, supplierId: input.supplierId } },
    });
    if (!current || !current.active) {
      throw new SupplierReferenceError("REFERENCE_NOT_FOUND", "Active supplier reference not found");
    }

    const reference = await tx.partSupplier.update({
      where: { partId_supplierId: { partId: input.partId, supplierId: input.supplierId } },
      data: { active: false, preferred: false },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: "PartSupplier",
        entityId: `${input.partId}:${input.supplierId}`,
        action: "DISABLED",
        beforeJson: JSON.stringify(referenceSnapshot(current)),
        afterJson: JSON.stringify(referenceSnapshot(reference)),
      },
    });
    return reference;
  });
}
