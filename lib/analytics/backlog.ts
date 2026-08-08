import { db } from "@/lib/db";

export const BACKLOG_DETAIL_LIMIT = 10;

const OPEN_STATUSES = ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] as const;

function daysBefore(now: Date, days: number) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export async function buildBacklogDashboard(input: {
  organizationId: string;
  siteId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const sevenDaysAgo = daysBefore(now, 7);
  const thirtyDaysAgo = daysBefore(now, 30);
  const ninetyDaysAgo = daysBefore(now, 90);
  const scope = {
    siteId: input.siteId,
    site: { organizationId: input.organizationId, active: true },
  } as const;
  const openScope = {
    ...scope,
    status: { in: [...OPEN_STATUSES] },
  } as const;

  const [
    requested,
    approved,
    planned,
    inProgress,
    blocked,
    overdue,
    unplanned,
    urgent,
    age0To6,
    age7To29,
    age30To89,
    age90Plus,
    oldest,
  ] = await Promise.all([
    db.workOrder.count({ where: { ...scope, status: "REQUESTED" } }),
    db.workOrder.count({ where: { ...scope, status: "APPROVED" } }),
    db.workOrder.count({ where: { ...scope, status: "PLANNED" } }),
    db.workOrder.count({ where: { ...scope, status: "IN_PROGRESS" } }),
    db.workOrder.count({ where: { ...scope, status: "BLOCKED" } }),
    db.workOrder.count({ where: { ...openScope, dueAt: { lt: now } } }),
    db.workOrder.count({ where: { ...openScope, plannedStart: null } }),
    db.workOrder.count({ where: { ...openScope, priority: "URGENT" } }),
    db.workOrder.count({
      where: { ...openScope, requestedAt: { gte: sevenDaysAgo, lte: now } },
    }),
    db.workOrder.count({
      where: { ...openScope, requestedAt: { gte: thirtyDaysAgo, lt: sevenDaysAgo } },
    }),
    db.workOrder.count({
      where: { ...openScope, requestedAt: { gte: ninetyDaysAgo, lt: thirtyDaysAgo } },
    }),
    db.workOrder.count({ where: { ...openScope, requestedAt: { lt: ninetyDaysAgo } } }),
    db.workOrder.findMany({
      where: openScope,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        requestedAt: true,
        dueAt: true,
        asset: { select: { code: true, name: true } },
      },
      orderBy: [{ requestedAt: "asc" }, { number: "asc" }],
      take: BACKLOG_DETAIL_LIMIT,
    }),
  ]);

  const totalOpen = requested + approved + planned + inProgress + blocked;
  return {
    generatedAt: now.toISOString(),
    empty: totalOpen === 0,
    totalOpen,
    overdue,
    unplanned,
    urgent,
    status: {
      REQUESTED: requested,
      APPROVED: approved,
      PLANNED: planned,
      IN_PROGRESS: inProgress,
      BLOCKED: blocked,
    },
    aging: {
      DAYS_0_6: age0To6,
      DAYS_7_29: age7To29,
      DAYS_30_89: age30To89,
      DAYS_90_PLUS: age90Plus,
    },
    oldest,
  };
}
