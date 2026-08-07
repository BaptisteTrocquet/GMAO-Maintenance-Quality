import type { Permission } from "@/lib/permissions";
import type { WorkOrderStatus } from "@prisma/client";

const transitions: Record<WorkOrderStatus, readonly WorkOrderStatus[]> = {
  REQUESTED: ["APPROVED", "CANCELLED"],
  APPROVED: ["PLANNED", "IN_PROGRESS", "CANCELLED"],
  PLANNED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "COMPLETED", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

const managerOnlyTransitions = new Set<string>([
  "REQUESTED:APPROVED",
  "REQUESTED:CANCELLED",
  "APPROVED:PLANNED",
  "APPROVED:CANCELLED",
  "PLANNED:CANCELLED",
  "IN_PROGRESS:CANCELLED",
  "BLOCKED:CANCELLED",
]);

export class WorkOrderWorkflowError extends Error {
  constructor(
    public readonly code: "INVALID_TRANSITION" | "PLANNING_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "WorkOrderWorkflowError";
  }
}

export function transitionPermission(from: WorkOrderStatus, to: WorkOrderStatus): Permission {
  assertTransitionAllowed(from, to);
  return managerOnlyTransitions.has(`${from}:${to}`) ? "work:manage" : "work:update";
}

export function assertTransitionAllowed(from: WorkOrderStatus, to: WorkOrderStatus): void {
  if (!transitions[from].includes(to)) {
    throw new WorkOrderWorkflowError(
      "INVALID_TRANSITION",
      `Work order cannot transition from ${from} to ${to}`,
    );
  }
}

export function assertTransitionRequirements(input: {
  from: WorkOrderStatus;
  to: WorkOrderStatus;
  plannedStart: Date | null;
}): void {
  assertTransitionAllowed(input.from, input.to);
  if (input.to === "PLANNED" && !input.plannedStart) {
    throw new WorkOrderWorkflowError(
      "PLANNING_REQUIRED",
      "A planned start date is required before moving a work order to PLANNED",
    );
  }
}

export function deriveTransitionDates(input: {
  from: WorkOrderStatus;
  to: WorkOrderStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return {
    startedAt: input.to === "IN_PROGRESS" && !input.startedAt ? now : input.startedAt,
    completedAt: input.to === "COMPLETED" ? now : input.completedAt,
  };
}
