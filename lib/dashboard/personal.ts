import type { MembershipRole, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export const PERSONAL_DASHBOARD_WORK_LIMIT = 12;

export async function buildPersonalDashboard(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  role: MembershipRole;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const through = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  if (!can(input.role, "work:read")) {
    return {
      teamCount: 0,
      openCount: 0,
      overdueCount: 0,
      dueSoonCount: 0,
      unscheduledCount: 0,
      workOrders: [],
    };
  }

  const teamMemberships = await db.maintenanceTeamMember.findMany({
    where: {
      userId: input.userId,
      team: {
        siteId: input.siteId,
        site: { organizationId: input.organizationId, active: true },
      },
    },
    select: { teamId: true },
  });
  const teamIds = teamMemberships.map((membership) => membership.teamId);

  const ownership: Prisma.WorkOrderWhereInput = teamIds.length
    ? { OR: [{ assigneeId: input.userId }, { teamId: { in: teamIds } }] }
    : { assigneeId: input.userId };
  const baseWhere: Prisma.WorkOrderWhereInput = {
    siteId: input.siteId,
    site: { organizationId: input.organizationId, active: true },
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    ...ownership,
  };

  const [openCount, overdueCount, dueSoonCount, unscheduledCount, workOrders] = await Promise.all([
    db.workOrder.count({ where: baseWhere }),
    db.workOrder.count({
      where: { ...baseWhere, dueAt: { lt: now } },
    }),
    db.workOrder.count({
      where: { ...baseWhere, dueAt: { gte: now, lte: through } },
    }),
    db.workOrder.count({
      where: { ...baseWhere, plannedStart: null },
    }),
    db.workOrder.findMany({
      where: baseWhere,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        plannedStart: true,
        dueAt: true,
        requestedAt: true,
        asset: { select: { code: true, name: true } },
        assignee: { select: { id: true, displayName: true } },
        team: { select: { id: true, name: true } },
      },
      orderBy: [{ dueAt: "asc" }, { requestedAt: "asc" }],
      take: PERSONAL_DASHBOARD_WORK_LIMIT,
    }),
  ]);

  return {
    teamCount: teamIds.length,
    openCount,
    overdueCount,
    dueSoonCount,
    unscheduledCount,
    workOrders,
  };
}
