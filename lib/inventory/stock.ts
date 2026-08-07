import { createHash } from "node:crypto";
import { Prisma, type StockMovementType } from "@prisma/client";
import { db } from "@/lib/db";
import { reservedQuantityForOthers } from "@/lib/inventory/reservations";

const MAX_TRANSACTION_ATTEMPTS = 4;

export class StockMovementError extends Error {
  constructor(
    public readonly code:
      | "PART_NOT_FOUND"
      | "BIN_NOT_FOUND"
      | "INSUFFICIENT_STOCK"
      | "IDEMPOTENCY_CONFLICT"
      | "BALANCE_DIVERGENCE",
    message: string,
  ) {
    super(message);
    this.name = "StockMovementError";
  }
}

export type ApplyStockMovementInput = {
  organizationId: string;
  siteId: string;
  binId: string;
  partId: string;
  type: StockMovementType;
  quantity?: number;
  targetQuantity?: number;
  idempotencyKey: string;
  actorId?: string | null;
  unitCost?: number | null;
  note?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
};

function requestHash(input: ApplyStockMovementInput) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        organizationId: input.organizationId,
        siteId: input.siteId,
        binId: input.binId,
        partId: input.partId,
        type: input.type,
        quantity: input.quantity ?? null,
        targetQuantity: input.targetQuantity ?? null,
        unitCost: input.unitCost ?? null,
        note: input.note ?? null,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
      }),
    )
    .digest("hex");
}

function movementAction(type: StockMovementType) {
  switch (type) {
    case "RECEIPT":
      return "STOCK_RECEIVED";
    case "ISSUE":
      return "STOCK_ISSUED";
    case "ADJUSTMENT":
      return "STOCK_ADJUSTED";
    case "WORK_ORDER_CONSUMPTION":
      return "STOCK_CONSUMED";
  }
}

function movementDelta(input: ApplyStockMovementInput, currentBalance: number) {
  if (input.type === "ADJUSTMENT") {
    if (input.targetQuantity === undefined || input.targetQuantity < 0) {
      throw new StockMovementError(
        "BALANCE_DIVERGENCE",
        "Adjustment requires a non-negative target quantity",
      );
    }
    return input.targetQuantity - currentBalance;
  }

  if (input.quantity === undefined || !Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new StockMovementError(
      "BALANCE_DIVERGENCE",
      "Receipt and issue quantities must be positive",
    );
  }
  return input.type === "RECEIPT" ? input.quantity : -input.quantity;
}

function retryableTransactionError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || error.code === "P2002")
  );
}

export async function applyStockMovement(
  tx: Prisma.TransactionClient,
  input: ApplyStockMovementInput,
) {
  const hash = requestHash(input);
  const existing = await tx.stockMovement.findUnique({
    where: {
      binId_idempotencyKey: {
        binId: input.binId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    if (existing.requestHash !== hash) {
      throw new StockMovementError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used for a different stock movement",
      );
    }
    return { movement: existing, idempotent: true } as const;
  }

  const [bin, part] = await Promise.all([
    tx.stockBin.findFirst({
      where: {
        id: input.binId,
        active: true,
        warehouse: {
          active: true,
          siteId: input.siteId,
          site: { organizationId: input.organizationId, active: true },
        },
      },
      select: { id: true },
    }),
    tx.part.findFirst({
      where: {
        id: input.partId,
        organizationId: input.organizationId,
        active: true,
      },
      select: { id: true, quantityOnHand: true, unitCost: true },
    }),
  ]);
  if (!bin) throw new StockMovementError("BIN_NOT_FOUND", "Active stock bin not found in site scope");
  if (!part) throw new StockMovementError("PART_NOT_FOUND", "Active part not found in organization scope");

  const current = await tx.stockBalance.findUnique({
    where: { binId_partId: { binId: input.binId, partId: input.partId } },
    select: { id: true, quantity: true },
  });
  const currentBalance = current?.quantity ?? 0;
  const delta = movementDelta(input, currentBalance);
  const balanceAfter = currentBalance + delta;
  if (balanceAfter < 0) {
    throw new StockMovementError("INSUFFICIENT_STOCK", "Stock movement would make the bin negative");
  }

  if (delta < 0) {
    if (!current) {
      throw new StockMovementError("INSUFFICIENT_STOCK", "No stock is available in this bin");
    }

    const workOrderId =
      input.type === "WORK_ORDER_CONSUMPTION" && input.referenceType === "WorkOrder"
        ? input.referenceId
        : null;
    const reservedForOthers = await reservedQuantityForOthers(tx, {
      binId: input.binId,
      partId: input.partId,
      workOrderId,
    });
    const availableToMovement = currentBalance - reservedForOthers;
    if (availableToMovement < Math.abs(delta)) {
      throw new StockMovementError(
        "INSUFFICIENT_STOCK",
        "Stock movement would consume quantity reserved for another work order",
      );
    }

    const balanceUpdate = await tx.stockBalance.updateMany({
      where: {
        id: current.id,
        quantity: { gte: Math.abs(delta) },
      },
      data: { quantity: { decrement: Math.abs(delta) } },
    });
    if (balanceUpdate.count !== 1) {
      throw new StockMovementError("INSUFFICIENT_STOCK", "Concurrent stock use exhausted this bin");
    }
  } else if (delta > 0) {
    await tx.stockBalance.upsert({
      where: { binId_partId: { binId: input.binId, partId: input.partId } },
      create: { binId: input.binId, partId: input.partId, quantity: delta },
      update: { quantity: { increment: delta } },
    });
  } else if (!current) {
    await tx.stockBalance.create({
      data: { binId: input.binId, partId: input.partId, quantity: 0 },
    });
  }

  let partQuantityAfter = part.quantityOnHand;
  if (delta < 0) {
    const aggregateUpdate = await tx.part.updateMany({
      where: {
        id: part.id,
        organizationId: input.organizationId,
        quantityOnHand: { gte: Math.abs(delta) },
      },
      data: { quantityOnHand: { decrement: Math.abs(delta) } },
    });
    if (aggregateUpdate.count !== 1) {
      throw new StockMovementError(
        "BALANCE_DIVERGENCE",
        "Part aggregate is lower than the bin balance; reconcile stock before issuing",
      );
    }
    const refreshed = await tx.part.findUnique({
      where: { id: part.id },
      select: { quantityOnHand: true },
    });
    if (!refreshed) throw new StockMovementError("PART_NOT_FOUND", "Part disappeared during stock update");
    partQuantityAfter = refreshed.quantityOnHand;
  } else if (delta > 0) {
    const refreshed = await tx.part.update({
      where: { id: part.id },
      data: { quantityOnHand: { increment: delta } },
      select: { quantityOnHand: true },
    });
    partQuantityAfter = refreshed.quantityOnHand;
  }

  const movement = await tx.stockMovement.create({
    data: {
      binId: input.binId,
      partId: input.partId,
      type: input.type,
      delta,
      balanceAfter,
      partQuantityAfter,
      unitCost: input.unitCost ?? part.unitCost,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      actorId: input.actorId ?? null,
      note: input.note ?? null,
    },
  });

  await tx.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      entityType: "StockMovement",
      entityId: movement.id,
      action: movementAction(input.type),
      afterJson: JSON.stringify({
        organizationId: input.organizationId,
        siteId: input.siteId,
        binId: input.binId,
        partId: input.partId,
        type: input.type,
        delta,
        balanceAfter,
        partQuantityAfter,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        note: input.note ?? null,
      }),
    },
  });

  return { movement, idempotent: false } as const;
}

export async function recordStockMovement(input: ApplyStockMovementInput) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction((tx) => applyStockMovement(tx, input), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      lastError = error;
      if (!retryableTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}

export async function listStockBalances(input: {
  organizationId: string;
  siteId: string;
  partId?: string;
  binId?: string;
}) {
  return db.stockBalance.findMany({
    where: {
      ...(input.partId ? { partId: input.partId } : {}),
      ...(input.binId ? { binId: input.binId } : {}),
      bin: {
        warehouse: {
          siteId: input.siteId,
          site: { organizationId: input.organizationId, active: true },
        },
      },
      part: { organizationId: input.organizationId },
    },
    include: {
      part: { select: { id: true, sku: true, name: true, unit: true, reorderPoint: true } },
      bin: {
        select: {
          id: true,
          code: true,
          name: true,
          warehouse: { select: { id: true, code: true, name: true, siteId: true } },
        },
      },
    },
    orderBy: [{ part: { sku: "asc" } }, { bin: { code: "asc" } }],
  });
}

export async function listStockMovements(input: {
  organizationId: string;
  siteId: string;
  partId?: string;
  binId?: string;
  take?: number;
}) {
  return db.stockMovement.findMany({
    where: {
      ...(input.partId ? { partId: input.partId } : {}),
      ...(input.binId ? { binId: input.binId } : {}),
      bin: {
        warehouse: {
          siteId: input.siteId,
          site: { organizationId: input.organizationId, active: true },
        },
      },
      part: { organizationId: input.organizationId },
    },
    include: {
      part: { select: { id: true, sku: true, name: true, unit: true } },
      bin: {
        select: {
          id: true,
          code: true,
          name: true,
          warehouse: { select: { id: true, code: true, name: true, siteId: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.take ?? 100, 1), 500),
  });
}
