import type { Prisma, WorkOrderStatus } from "@prisma/client";

export const PLANNING_ACTIVE_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "PLANNED",
  "IN_PROGRESS",
  "BLOCKED",
] as const satisfies readonly WorkOrderStatus[];

function planningScope(input: { organizationId: string; siteId: string }): Prisma.WorkOrderWhereInput {
  return {
    siteId: input.siteId,
    site: { organizationId: input.organizationId, active: true },
    status: { in: [...PLANNING_ACTIVE_STATUSES] },
  };
}

export function buildScheduledPlanningWhere(input: {
  organizationId: string;
  siteId: string;
  rangeStart: Date;
  rangeEnd: Date;
}): Prisma.WorkOrderWhereInput {
  return {
    ...planningScope(input),
    plannedStart: { gte: input.rangeStart, lt: input.rangeEnd },
  };
}

export function buildUnscheduledPlanningWhere(input: {
  organizationId: string;
  siteId: string;
}): Prisma.WorkOrderWhereInput {
  return {
    ...planningScope(input),
    plannedStart: null,
  };
}
