import type { Prisma, Priority } from "@prisma/client";
import { db } from "@/lib/db";

export const BULK_WORK_ORDER_LIMIT = 50;

export type BulkTriageChanges = {
  priority?: Priority;
  plannedStart?: Date | null;
  dueAt?: Date | null;
};

export class BulkWorkOrderError extends Error {
  constructor(
    public readonly code:
      | "INVALID_SELECTION"
      | "NO_CHANGES"
      | "WORK_ORDER_NOT_FOUND"
      | "INVALID_PLANNING",
    message: string,
  ) {
    super(message);
    this.name = "BulkWorkOrderError";
  }
}

function hasOwn(input: object, key: keyof BulkTriageChanges) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function updateData(changes: BulkTriageChanges): Prisma.WorkOrderUncheckedUpdateInput {
  const data: Prisma.WorkOrderUncheckedUpdateInput = {};
  if (changes.priority !== undefined) data.priority = changes.priority;
  if (hasOwn(changes, "plannedStart")) data.plannedStart = changes.plannedStart ?? null;
  if (hasOwn(changes, "dueAt")) data.dueAt = changes.dueAt ?? null;
  return data;
}

export async function bulkTriageWorkOrders(input: {
  organizationId: string;
  siteId: string;
  workOrderIds: string[];
  changes: BulkTriageChanges;
  actorId: string;
}) {
  const workOrderIds = [...new Set(input.workOrderIds)].sort();
  if (!workOrderIds.length || workOrderIds.length > BULK_WORK_ORDER_LIMIT) {
    throw new BulkWorkOrderError(
      "INVALID_SELECTION",
      `Select between 1 and ${BULK_WORK_ORDER_LIMIT} work orders`,
    );
  }

  const hasChanges =
    input.changes.priority !== undefined ||
    hasOwn(input.changes, "plannedStart") ||
    hasOwn(input.changes, "dueAt");
  if (!hasChanges) {
    throw new BulkWorkOrderError("NO_CHANGES", "At least one bulk triage field must change");
  }

  return db.$transaction(async (tx) => {
    const workOrders = await tx.workOrder.findMany({
      where: {
        id: { in: workOrderIds },
        siteId: input.siteId,
        site: { organizationId: input.organizationId, active: true },
      },
      select: {
        id: true,
        number: true,
        priority: true,
        plannedStart: true,
        dueAt: true,
      },
      orderBy: { id: "asc" },
    });

    if (workOrders.length !== workOrderIds.length) {
      throw new BulkWorkOrderError(
        "WORK_ORDER_NOT_FOUND",
        "Every selected work order must belong to the active organization/site scope",
      );
    }

    for (const workOrder of workOrders) {
      const plannedStart = hasOwn(input.changes, "plannedStart")
        ? (input.changes.plannedStart ?? null)
        : workOrder.plannedStart;
      const dueAt = hasOwn(input.changes, "dueAt")
        ? (input.changes.dueAt ?? null)
        : workOrder.dueAt;
      if (plannedStart && dueAt && dueAt.getTime() < plannedStart.getTime()) {
        throw new BulkWorkOrderError(
          "INVALID_PLANNING",
          `${workOrder.number} would have a due date earlier than its planned start`,
        );
      }
    }

    const data = updateData(input.changes);
    const updatedIds: string[] = [];
    for (const workOrder of workOrders) {
      const updated = await tx.workOrder.update({
        where: { id: workOrder.id },
        data,
      });
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "WorkOrder",
          entityId: workOrder.id,
          action: "BULK_TRIAGED",
          beforeJson: JSON.stringify(workOrder),
          afterJson: JSON.stringify({
            workOrder: updated,
            bulk: true,
            changedFields: Object.keys(input.changes),
          }),
        },
      });
      updatedIds.push(workOrder.id);
    }

    return { updatedIds, count: updatedIds.length };
  });
}
