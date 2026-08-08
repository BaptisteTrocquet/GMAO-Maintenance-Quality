import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const MAX_TRANSACTION_ATTEMPTS = 4;
const RESCHEDULABLE_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "PLANNED",
  "IN_PROGRESS",
  "BLOCKED",
] as const;

export class WorkOrderRescheduleError extends Error {
  constructor(
    public readonly code:
      | "WORK_ORDER_NOT_FOUND"
      | "WORK_ORDER_NOT_RESCHEDULABLE"
      | "INVALID_PLANNING",
    message: string,
  ) {
    super(message);
    this.name = "WorkOrderRescheduleError";
  }
}

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export async function rescheduleWorkOrder(input: {
  organizationId: string;
  siteId: string;
  workOrderId: string;
  plannedStart: Date;
  dueAt: Date | null;
  actorId: string;
}) {
  if (!Number.isFinite(input.plannedStart.getTime())) {
    throw new WorkOrderRescheduleError("INVALID_PLANNING", "plannedStart must be a valid date");
  }
  if (input.dueAt && !Number.isFinite(input.dueAt.getTime())) {
    throw new WorkOrderRescheduleError("INVALID_PLANNING", "dueAt must be a valid date when supplied");
  }
  if (input.dueAt && input.dueAt.getTime() < input.plannedStart.getTime()) {
    throw new WorkOrderRescheduleError(
      "INVALID_PLANNING",
      "dueAt cannot be earlier than plannedStart",
    );
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
          });
          if (!current) {
            throw new WorkOrderRescheduleError(
              "WORK_ORDER_NOT_FOUND",
              "Work order not found in site scope",
            );
          }
          if (!RESCHEDULABLE_STATUSES.includes(current.status as (typeof RESCHEDULABLE_STATUSES)[number])) {
            throw new WorkOrderRescheduleError(
              "WORK_ORDER_NOT_RESCHEDULABLE",
              "Completed or cancelled work orders cannot be rescheduled",
            );
          }
          if (
            current.plannedStart?.getTime() === input.plannedStart.getTime() &&
            (current.dueAt?.getTime() ?? null) === (input.dueAt?.getTime() ?? null)
          ) {
            return { workOrder: current, changed: false } as const;
          }

          const updated = await tx.workOrder.update({
            where: { id: current.id },
            data: {
              plannedStart: input.plannedStart,
              dueAt: input.dueAt,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              entityType: "WorkOrder",
              entityId: current.id,
              action: "RESCHEDULED",
              beforeJson: JSON.stringify({
                plannedStart: current.plannedStart,
                dueAt: current.dueAt,
              }),
              afterJson: JSON.stringify({
                plannedStart: updated.plannedStart,
                dueAt: updated.dueAt,
              }),
            },
          });

          return { workOrder: updated, changed: true } as const;
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
