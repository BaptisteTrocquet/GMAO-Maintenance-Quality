import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { consumeWorkOrderReservation } from "@/lib/inventory/reservations";
import { applyStockMovement, StockMovementError } from "@/lib/inventory/stock";

const MAX_TRANSACTION_ATTEMPTS = 4;

export class WorkOrderPartError extends Error {
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
    this.name = "WorkOrderPartError";
  }
}

function fromStockError(error: StockMovementError) {
  return new WorkOrderPartError(error.code, error.message);
}

function retryable(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || error.code === "P2002")
  );
}

export async function consumeWorkOrderPart(input: {
  organizationId: string;
  siteId: string;
  workOrderId: string;
  partId: string;
  binId: string;
  quantity: number;
  idempotencyKey: string;
  actorId: string;
}) {
  const uniqueWhere = {
    workOrderId_idempotencyKey: {
      workOrderId: input.workOrderId,
      idempotencyKey: input.idempotencyKey,
    },
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const duplicate = await tx.workOrderPartConsumption.findUnique({
            where: uniqueWhere,
            include: { part: true, bin: true },
          });
          if (duplicate) return { consumption: duplicate, idempotent: true } as const;

          const part = await tx.part.findFirst({
            where: {
              id: input.partId,
              organizationId: input.organizationId,
              active: true,
            },
            select: {
              id: true,
              sku: true,
              name: true,
              unitCost: true,
            },
          });
          if (!part) {
            throw new WorkOrderPartError("PART_NOT_FOUND", "Part not found in organization scope");
          }

          let stockResult;
          try {
            stockResult = await applyStockMovement(tx, {
              organizationId: input.organizationId,
              siteId: input.siteId,
              binId: input.binId,
              partId: part.id,
              type: "WORK_ORDER_CONSUMPTION",
              quantity: input.quantity,
              idempotencyKey: `wo:${input.workOrderId}:${input.idempotencyKey}`,
              actorId: input.actorId,
              unitCost: part.unitCost ? Number(part.unitCost) : null,
              referenceType: "WorkOrder",
              referenceId: input.workOrderId,
            });
          } catch (error) {
            if (error instanceof StockMovementError) throw fromStockError(error);
            throw error;
          }

          const reservation = await consumeWorkOrderReservation(tx, {
            workOrderId: input.workOrderId,
            binId: input.binId,
            partId: part.id,
            quantity: input.quantity,
            actorId: input.actorId,
          });

          await tx.workOrderPart.upsert({
            where: {
              workOrderId_partId: { workOrderId: input.workOrderId, partId: part.id },
            },
            create: {
              workOrderId: input.workOrderId,
              partId: part.id,
              quantity: input.quantity,
              unitCost: part.unitCost,
            },
            update: {
              quantity: { increment: input.quantity },
              unitCost: part.unitCost,
            },
          });

          const consumption = await tx.workOrderPartConsumption.create({
            data: {
              workOrderId: input.workOrderId,
              partId: part.id,
              binId: input.binId,
              quantity: input.quantity,
              unitCost: part.unitCost,
              idempotencyKey: input.idempotencyKey,
              actorId: input.actorId,
            },
            include: { part: true, bin: true },
          });

          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              entityType: "WorkOrder",
              entityId: input.workOrderId,
              action: "PART_CONSUMED",
              afterJson: JSON.stringify({
                partId: part.id,
                sku: part.sku,
                binId: input.binId,
                quantity: input.quantity,
                consumptionId: consumption.id,
                stockMovementId: stockResult.movement.id,
                reservationStatus: reservation?.status ?? null,
                idempotencyKey: input.idempotencyKey,
              }),
            },
          });

          return { consumption, idempotent: false } as const;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof WorkOrderPartError) throw error;
      lastError = error;

      const duplicate = await db.workOrderPartConsumption.findUnique({
        where: uniqueWhere,
        include: { part: true, bin: true },
      });
      if (duplicate) return { consumption: duplicate, idempotent: true } as const;

      if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }

  throw lastError;
}
