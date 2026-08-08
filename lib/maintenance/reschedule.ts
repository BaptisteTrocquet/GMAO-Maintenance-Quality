import { Prisma, type WorkOrderStatus } from "@prisma/client";
import { db } from "@/lib/db";

const MAX_TRANSACTION_ATTEMPTS = 4;

export class WorkOrderRescheduleError extends Error {
  constructor(
    public readonly code:
      | "WORK_ORDER_NOT_FOUND"
      | "SCHEDULING_REQUIRES_APPROVAL"
      | "WORK_ORDER_NOT_RESCHEDULABLE"
      | "INVALID_PLANNED_START",
    message: string,
  ) {
    super(message);
    this.name = "WorkOrderRescheduleError";
  }
}

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function nextStatus(status: WorkOrderStatus): WorkOrderStatus {
  if (status === "REQUESTED") {
    throw new WorkOrderRescheduleError(
      "SCHEDULING_REQUIRES_APPROVAL",
      "Approve the work order before assigning a planned start",
    );
  }
  if (status === "COMPLETED" || status === "CANCELLED") {
    throw new WorkOrderRescheduleError(
      "WORK_ORDER_NOT_RESCHEDULABLE",
      "Completed or cancelled work orders cannot be rescheduled",
    );
  }
  return status === "APPROVED" ? "PLANNED" : status;
}

export async function rescheduleWorkOrder(input: {
  organizationId: string;
  siteId: string;
  workOrderId: string;
  plannedStart: Date;
  actorId: string;
  reason?: string | null;
}) {
  if (!Number.isFinite(input.plannedStart.getTime())) {
    throw new WorkOrderRescheduleError("INVALID_PLANNED_START", "plannedStart must be a valid date");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const current = await tx.workOrder.findFirst({
            where: {
              id: input.workOrderId,
              siteId: input.siteId,
              site: { organizationId: input.organizationId, active: true },
            },
            select: {
              id: true,
              number: true,
              status: true,
              plannedStart: true,
              updatedAt: true,
            },
          });
          if (!current) {
            throw new WorkOrderRescheduleError(
              "WORK_ORDER_NOT_FOUND",
              "Work order not found in site scope",
            );
          }

          const status = nextStatus(current.status);
          const updated = await tx.workOrder.update({
            where: { id: current.id },
            data: {
              plannedStart: input.plannedStart,
              ...(status !== current.status ? { status } : {}),
            },
            select: {
              id: true,
              number: true,
              status: true,
              plannedStart: true,
              updatedAt: true,
            },
          });

          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              entityType: "WorkOrder",
              entityId: current.id,
              action: "RESCHEDULED",
              beforeJson: JSON.stringify({
                status: current.status,
                plannedStart: current.plannedStart?.toISOString() ?? null,
              }),
              afterJson: JSON.stringify({
                status: updated.status,
                plannedStart: updated.plannedStart?.toISOString() ?? null,
                reason: input.reason?.trim() || null,
              }),
            },
          });

          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof WorkOrderRescheduleError) throw error;
      lastError = error;
      if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}
