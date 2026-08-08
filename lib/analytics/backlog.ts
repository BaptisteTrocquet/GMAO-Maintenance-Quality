import { db } from "@/lib/db";
import {
  localCalendarDate,
  localDateStartUtc,
  shiftCalendarDate,
} from "@/lib/analytics/date-range";

export const BACKLOG_DETAIL_LIMIT = 10;

const OPEN_STATUSES = ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] as const;

export async function buildBacklogDashboard(input: {
  organizationId: string;
  siteId: string;
  timeZone: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const today = localCalendarDate(now, input.timeZone);
  const dueSoonExclusive = localDateStartUtc(shiftCalendarDate(today, 7), input.timeZone);
  const sevenDayBoundary = localDateStartUtc(shiftCalendarDate(today, -6), input.timeZone);
  const thirtyDayBoundary = localDateStartUtc(shiftCalendarDate(today, -29), input.timeZone);
  const ninetyDayBoundary = localDateStartUtc(shiftCalendarDate(today, -89), input.timeZone);
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
    dueSoon,
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
    db.workOrder.count({ where: { ...openScope, dueAt: { gte: now, lt: dueSoonExclusive } } }),
    db.workOrder.count({ where: { ...openScope, plannedStart: null } }),
    db.workOrder.count({ where: { ...openScope, priority: "URGENT" } }),
    db.workOrder.count({
      where: { ...openScope, requestedAt: { gte: sevenDayBoundary, lte: now } },
    }),
    db.workOrder.count({
      where: { ...openScope, requestedAt: { gte: thirtyDayBoundary, lt: sevenDayBoundary } },
    }),
    db.workOrder.count({
      where: { ...openScope, requestedAt: { gte: ninetyDayBoundary, lt: thirtyDayBoundary } },
    }),
    db.workOrder.count({ where: { ...openScope, requestedAt: { lt: ninetyDayBoundary } } }),
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
    timezone: input.timeZone,
    empty: totalOpen === 0,
    totalOpen,
    overdue,
    dueSoon,
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
