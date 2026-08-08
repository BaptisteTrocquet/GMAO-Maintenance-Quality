import type { MembershipRole } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export const PERSONAL_DASHBOARD_WORK_LIMIT = 30;
export const PERSONAL_DASHBOARD_REMINDER_LIMIT = 20;

function myWorkScope(userId: string) {
  return {
    OR: [
      { assigneeId: userId },
      {
        assigneeId: null,
        team: { members: { some: { userId } } },
      },
    ],
  } as const;
}

export async function buildPersonalMaintenanceDashboard(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  role: MembershipRole;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const dueSoonThrough = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  if (!can(input.role, "work:read")) {
    return {
      workOrders: [],
      reminders: [],
      counts: { active: 0, overdue: 0, dueSoon: 0, blocked: 0, inProgress: 0, reminders: 0 },
    };
  }

  const ownership = myWorkScope(input.userId);
  const [workOrders, reminders] = await Promise.all([
    db.workOrder.findMany({
      where: {
        siteId: input.siteId,
        site: { organizationId: input.organizationId, active: true },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        ...ownership,
      },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        plannedStart: true,
        dueAt: true,
        assigneeId: true,
        asset: { select: { code: true } },
        team: { select: { name: true } },
      },
      orderBy: [{ dueAt: "asc" }, { priority: "desc" }, { requestedAt: "asc" }],
      take: PERSONAL_DASHBOARD_WORK_LIMIT,
    }),
    can(input.role, "maintenance:read")
      ? db.maintenanceReminder.findMany({
          where: {
            siteId: input.siteId,
            site: { organizationId: input.organizationId, active: true },
            status: "ACTIVE",
            workOrder: {
              status: { notIn: ["COMPLETED", "CANCELLED"] },
              ...ownership,
            },
          },
          select: {
            id: true,
            title: true,
            assetCode: true,
            dueAt: true,
            remindAt: true,
            workOrder: { select: { id: true, number: true } },
          },
          orderBy: { dueAt: "asc" },
          take: PERSONAL_DASHBOARD_REMINDER_LIMIT,
        })
      : Promise.resolve([]),
  ]);

  const decorated = workOrders.map((workOrder) => ({
    id: workOrder.id,
    number: workOrder.number,
    title: workOrder.title,
    status: workOrder.status,
    priority: workOrder.priority,
    plannedStart: workOrder.plannedStart,
    dueAt: workOrder.dueAt,
    assetCode: workOrder.asset?.code ?? null,
    teamName: workOrder.team?.name ?? null,
    ownership: workOrder.assigneeId === input.userId ? ("ASSIGNED" as const) : ("TEAM" as const),
    overdue: Boolean(workOrder.dueAt && workOrder.dueAt < now),
    dueSoon: Boolean(
      workOrder.dueAt && workOrder.dueAt >= now && workOrder.dueAt <= dueSoonThrough,
    ),
  }));

  return {
    workOrders: decorated,
    reminders,
    counts: {
      active: decorated.length,
      overdue: decorated.filter((item) => item.overdue).length,
      dueSoon: decorated.filter((item) => item.dueSoon).length,
      blocked: decorated.filter((item) => item.status === "BLOCKED").length,
      inProgress: decorated.filter((item) => item.status === "IN_PROGRESS").length,
      reminders: reminders.length,
    },
  };
}
