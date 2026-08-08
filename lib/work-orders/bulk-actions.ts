import type { MembershipRole, Priority, Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const BULK_WORK_ORDER_LIMIT = 50;
export const BULK_WORK_ORDER_CANDIDATE_LIMIT = 200;

export type BulkWorkOrderOperation =
  | { type: "SET_PRIORITY"; priority: Priority }
  | { type: "SET_ASSIGNEE"; assigneeId: string | null }
  | { type: "SET_TEAM"; teamId: string | null };

export class BulkWorkOrderError extends Error {
  constructor(
    public readonly code:
      | "EMPTY_SELECTION"
      | "BATCH_TOO_LARGE"
      | "WORK_ORDER_SCOPE_MISMATCH"
      | "WORK_ORDER_NOT_EDITABLE"
      | "ASSIGNEE_NOT_FOUND"
      | "TEAM_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "BulkWorkOrderError";
  }
}

function uniqueIds(workOrderIds: string[]) {
  return [...new Set(workOrderIds.map((value) => value.trim()).filter(Boolean))];
}

function operationData(operation: BulkWorkOrderOperation): Prisma.WorkOrderUncheckedUpdateInput {
  switch (operation.type) {
    case "SET_PRIORITY":
      return { priority: operation.priority };
    case "SET_ASSIGNEE":
      return { assigneeId: operation.assigneeId };
    case "SET_TEAM":
      return { teamId: operation.teamId };
  }
}

function alreadyApplied(
  workOrder: { priority: Priority; assigneeId: string | null; teamId: string | null },
  operation: BulkWorkOrderOperation,
) {
  switch (operation.type) {
    case "SET_PRIORITY":
      return workOrder.priority === operation.priority;
    case "SET_ASSIGNEE":
      return workOrder.assigneeId === operation.assigneeId;
    case "SET_TEAM":
      return workOrder.teamId === operation.teamId;
  }
}

async function validateAssignment(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    siteId: string;
    operation: BulkWorkOrderOperation;
  },
) {
  if (input.operation.type === "SET_ASSIGNEE" && input.operation.assigneeId) {
    const membership = await tx.organizationMembership.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.operation.assigneeId,
        active: true,
        role: { in: ["OWNER", "ADMIN", "MAINTENANCE_MANAGER", "TECHNICIAN"] },
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId: input.siteId } } }],
      },
      select: { id: true },
    });
    if (!membership) {
      throw new BulkWorkOrderError(
        "ASSIGNEE_NOT_FOUND",
        "Assignee is not an active maintenance member for this site",
      );
    }
  }

  if (input.operation.type === "SET_TEAM" && input.operation.teamId) {
    const team = await tx.maintenanceTeam.findFirst({
      where: {
        id: input.operation.teamId,
        siteId: input.siteId,
        active: true,
        site: { organizationId: input.organizationId, active: true },
      },
      select: { id: true },
    });
    if (!team) {
      throw new BulkWorkOrderError(
        "TEAM_NOT_FOUND",
        "Maintenance team not found in site scope",
      );
    }
  }
}

export async function bulkTriageWorkOrders(input: {
  organizationId: string;
  siteId: string;
  workOrderIds: string[];
  operation: BulkWorkOrderOperation;
  actorId: string;
}) {
  const workOrderIds = uniqueIds(input.workOrderIds);
  if (!workOrderIds.length) {
    throw new BulkWorkOrderError("EMPTY_SELECTION", "Select at least one work order");
  }
  if (workOrderIds.length > BULK_WORK_ORDER_LIMIT) {
    throw new BulkWorkOrderError(
      "BATCH_TOO_LARGE",
      `Bulk actions support at most ${BULK_WORK_ORDER_LIMIT} work orders per request`,
    );
  }

  return db.$transaction(async (tx) => {
    const workOrders = await tx.workOrder.findMany({
      where: {
        id: { in: workOrderIds },
        siteId: input.siteId,
        site: { organizationId: input.organizationId, active: true },
      },
      orderBy: { number: "asc" },
    });
    if (workOrders.length !== workOrderIds.length) {
      throw new BulkWorkOrderError(
        "WORK_ORDER_SCOPE_MISMATCH",
        "Every selected work order must exist in the requested organization and site",
      );
    }
    if (workOrders.some((workOrder) => workOrder.status === "COMPLETED" || workOrder.status === "CANCELLED")) {
      throw new BulkWorkOrderError(
        "WORK_ORDER_NOT_EDITABLE",
        "Completed or cancelled work orders cannot be changed by bulk actions",
      );
    }

    await validateAssignment(tx, input);
    const data = operationData(input.operation);
    const changed = [];

    for (const workOrder of workOrders) {
      if (alreadyApplied(workOrder, input.operation)) continue;

      const next = await tx.workOrder.update({
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
            workOrder: next,
            bulk: {
              operation: input.operation,
              selectedCount: workOrders.length,
            },
          }),
        },
      });
      changed.push(next);
    }

    return {
      selectedCount: workOrders.length,
      updatedCount: changed.length,
      workOrders: changed,
    };
  });
}

export async function listBulkActionOptions(input: {
  organizationId: string;
  siteId: string;
}) {
  const [workOrders, teams, memberships] = await Promise.all([
    db.workOrder.findMany({
      where: {
        siteId: input.siteId,
        site: { organizationId: input.organizationId, active: true },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        dueAt: true,
        assignee: { select: { id: true, displayName: true } },
        team: { select: { id: true, name: true } },
        asset: { select: { code: true } },
      },
      orderBy: [{ dueAt: "asc" }, { number: "asc" }],
      take: BULK_WORK_ORDER_CANDIDATE_LIMIT + 1,
    }),
    db.maintenanceTeam.findMany({
      where: {
        siteId: input.siteId,
        active: true,
        site: { organizationId: input.organizationId, active: true },
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    db.organizationMembership.findMany({
      where: {
        organizationId: input.organizationId,
        active: true,
        role: { in: ["OWNER", "ADMIN", "MAINTENANCE_MANAGER", "TECHNICIAN"] },
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId: input.siteId } } }],
      },
      select: {
        user: { select: { id: true, displayName: true } },
        role: true,
      },
      orderBy: { user: { displayName: "asc" } },
    }),
  ]);

  const truncated = workOrders.length > BULK_WORK_ORDER_CANDIDATE_LIMIT;
  return {
    workOrders: workOrders.slice(0, BULK_WORK_ORDER_CANDIDATE_LIMIT),
    teams,
    assignees: memberships.map((membership: { user: { id: string; displayName: string }; role: MembershipRole }) => ({
      id: membership.user.id,
      displayName: membership.user.displayName,
      role: membership.role,
    })),
    truncated,
  };
}
