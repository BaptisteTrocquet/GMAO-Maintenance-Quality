import { db } from "@/lib/db";

export class WorkOrderPartError extends Error {
  constructor(
    public readonly code: "PART_NOT_FOUND" | "INSUFFICIENT_STOCK",
    message: string,
  ) {
    super(message);
    this.name = "WorkOrderPartError";
  }
}

export async function consumeWorkOrderPart(input: {
  organizationId: string;
  workOrderId: string;
  partId: string;
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

  try {
    return await db.$transaction(async (tx) => {
      const duplicate = await tx.workOrderPartConsumption.findUnique({
        where: uniqueWhere,
        include: { part: true },
      });
      if (duplicate) return { consumption: duplicate, idempotent: true };

      const part = await tx.part.findFirst({
        where: { id: input.partId, organizationId: input.organizationId },
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

      const stockUpdate = await tx.part.updateMany({
        where: {
          id: part.id,
          organizationId: input.organizationId,
          quantityOnHand: { gte: input.quantity },
        },
        data: { quantityOnHand: { decrement: input.quantity } },
      });
      if (stockUpdate.count !== 1) {
        throw new WorkOrderPartError(
          "INSUFFICIENT_STOCK",
          "Insufficient stock for requested work-order consumption",
        );
      }

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
          quantity: input.quantity,
          unitCost: part.unitCost,
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId,
        },
        include: { part: true },
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
            quantity: input.quantity,
            consumptionId: consumption.id,
            idempotencyKey: input.idempotencyKey,
          }),
        },
      });

      return { consumption, idempotent: false };
    });
  } catch (error) {
    if (error instanceof WorkOrderPartError) throw error;

    const duplicate = await db.workOrderPartConsumption.findUnique({
      where: uniqueWhere,
      include: { part: true },
    });
    if (duplicate) return { consumption: duplicate, idempotent: true };

    throw error;
  }
}
