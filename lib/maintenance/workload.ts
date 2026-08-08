import type { Prisma } from "@prisma/client";

export const WORKLOAD_LIMIT = 750;
export const WORKLOAD_HORIZON_DAYS = 14;

const ACTIVE_STATUSES = ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] as const;

type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export type WorkloadWorkOrder = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  requestedAt: Date;
  plannedStart: Date | null;
  dueAt: Date | null;
  assigneeId: string | null;
  assigneeName: string | null;
  teamId: string | null;
  teamName: string | null;
};

export type WorkloadLane = {
  key: string;
  kind: "PERSON" | "TEAM" | "UNASSIGNED";
  label: string;
  total: number;
  inProgress: number;
  blocked: number;
  overdue: number;
  dueSoon: number;
  plannedInHorizon: number;
  unplanned: number;
  urgent: number;
};

export function buildWorkloadWhere(input: {
  organizationId: string;
  siteId: string;
}): Prisma.WorkOrderWhereInput {
  return {
    siteId: input.siteId,
    site: { organizationId: input.organizationId, active: true },
    status: { in: [...ACTIVE_STATUSES] },
  };
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function laneIdentity(workOrder: WorkloadWorkOrder) {
  if (workOrder.assigneeId) {
    return {
      key: `PERSON:${workOrder.assigneeId}`,
      kind: "PERSON" as const,
      label: workOrder.assigneeName ?? "Assigned user",
    };
  }
  if (workOrder.teamId) {
    return {
      key: `TEAM:${workOrder.teamId}`,
      kind: "TEAM" as const,
      label: workOrder.teamName ?? "Assigned team",
    };
  }
  return { key: "UNASSIGNED", kind: "UNASSIGNED" as const, label: "Unassigned" };
}

export function buildWorkloadLanes(input: {
  workOrders: WorkloadWorkOrder[];
  now: Date;
}) {
  const dueSoonEnd = addDays(input.now, 7);
  const horizonEnd = addDays(input.now, WORKLOAD_HORIZON_DAYS);
  const lanes = new Map<string, WorkloadLane>();

  for (const workOrder of input.workOrders) {
    if (!ACTIVE_STATUSES.includes(workOrder.status as ActiveStatus)) continue;
    const identity = laneIdentity(workOrder);
    const lane = lanes.get(identity.key) ?? {
      ...identity,
      total: 0,
      inProgress: 0,
      blocked: 0,
      overdue: 0,
      dueSoon: 0,
      plannedInHorizon: 0,
      unplanned: 0,
      urgent: 0,
    };

    lane.total += 1;
    if (workOrder.status === "IN_PROGRESS") lane.inProgress += 1;
    if (workOrder.status === "BLOCKED") lane.blocked += 1;
    if (workOrder.priority === "URGENT") lane.urgent += 1;

    if (workOrder.dueAt && workOrder.dueAt < input.now) {
      lane.overdue += 1;
    } else if (workOrder.dueAt && workOrder.dueAt <= dueSoonEnd) {
      lane.dueSoon += 1;
    }

    if (!workOrder.plannedStart) {
      lane.unplanned += 1;
    } else if (workOrder.plannedStart >= input.now && workOrder.plannedStart <= horizonEnd) {
      lane.plannedInHorizon += 1;
    }

    lanes.set(identity.key, lane);
  }

  return [...lanes.values()].sort((left, right) => {
    const leftRisk = left.overdue * 100 + left.blocked * 20 + left.urgent * 10 + left.dueSoon * 5 + left.total;
    const rightRisk = right.overdue * 100 + right.blocked * 20 + right.urgent * 10 + right.dueSoon * 5 + right.total;
    if (rightRisk !== leftRisk) return rightRisk - leftRisk;
    if (left.kind === "UNASSIGNED" && right.kind !== "UNASSIGNED") return -1;
    if (right.kind === "UNASSIGNED" && left.kind !== "UNASSIGNED") return 1;
    return left.label.localeCompare(right.label);
  });
}
