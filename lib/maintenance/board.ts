import type { Priority, WorkOrderStatus } from "@prisma/client";

export const WORK_ORDER_BOARD_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "PLANNED",
  "IN_PROGRESS",
  "BLOCKED",
  "COMPLETED",
] as const satisfies readonly WorkOrderStatus[];

export type WorkOrderBoardStatus = (typeof WORK_ORDER_BOARD_STATUSES)[number];
export type WorkOrderDueFilter = "ALL" | "OVERDUE" | "DUE_7_DAYS" | "NO_DUE_DATE";

export type WorkOrderBoardItem = {
  id: string;
  number: string;
  title: string;
  status: WorkOrderStatus;
  priority: Priority;
  dueAt: Date | null;
  plannedStart: Date | null;
  requestedAt: Date;
  assetCode: string | null;
  assigneeName: string | null;
  teamName: string | null;
};

const PRIORITY_RANK: Record<Priority, number> = {
  URGENT: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

export function isWorkOrderOverdue(item: Pick<WorkOrderBoardItem, "status" | "dueAt">, now: Date) {
  return (
    item.dueAt !== null &&
    item.dueAt.getTime() < now.getTime() &&
    item.status !== "COMPLETED" &&
    item.status !== "CANCELLED"
  );
}

export function matchesDueFilter(
  item: Pick<WorkOrderBoardItem, "status" | "dueAt">,
  filter: WorkOrderDueFilter,
  now: Date,
) {
  if (filter === "ALL") return true;
  if (filter === "NO_DUE_DATE") return item.dueAt === null;
  if (filter === "OVERDUE") return isWorkOrderOverdue(item, now);
  if (!item.dueAt || item.status === "COMPLETED" || item.status === "CANCELLED") return false;

  const sevenDaysFromNow = now.getTime() + 7 * 24 * 60 * 60 * 1000;
  return item.dueAt.getTime() >= now.getTime() && item.dueAt.getTime() <= sevenDaysFromNow;
}

export function sortBoardItems(left: WorkOrderBoardItem, right: WorkOrderBoardItem) {
  const byPriority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (byPriority !== 0) return byPriority;

  const leftDue = left.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightDue = right.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) return leftDue - rightDue;

  return left.requestedAt.getTime() - right.requestedAt.getTime();
}

export function buildWorkOrderBoard(input: {
  workOrders: WorkOrderBoardItem[];
  dueFilter: WorkOrderDueFilter;
  now: Date;
}) {
  const visible = input.workOrders
    .filter((item) => item.status !== "CANCELLED")
    .filter((item) => matchesDueFilter(item, input.dueFilter, input.now));

  return WORK_ORDER_BOARD_STATUSES.map((status) => ({
    status,
    items: visible.filter((item) => item.status === status).sort(sortBoardItems),
  }));
}
