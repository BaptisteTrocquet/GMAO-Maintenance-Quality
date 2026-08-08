import type { MembershipRole, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export const PERSONAL_DASHBOARD_WORK_LIMIT = 8;
export const PERSONAL_DASHBOARD_APPROVAL_LIMIT = 6;

function assignedWorkWhere(input: {
  organizationId: string;
  siteId: string;
  userId: string;
}): Prisma.WorkOrderWhereInput {
  return {
    siteId: input.siteId,
    site: { organizationId: input.organizationId, active: true },
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    OR: [
      { assigneeId: input.userId },
      { team: { members: { some: { userId: input.userId } } } },
    ],
  };
}

export async function buildPersonalDashboard(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  role: MembershipRole;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const through = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const baseWork = assignedWorkWhere(input);
  const canReadWork = can(input.role, "work:read");
  const canApproveDocuments = can(input.role, "document:approve");

  const [openWork, blockedWork, overdueWork, dueSoonWork, urgentWork, workOrders, approvalCount, approvals] =
    await Promise.all([
      canReadWork ? db.workOrder.count({ where: baseWork }) : Promise.resolve(0),
      canReadWork
        ? db.workOrder.count({ where: { AND: [baseWork, { status: "BLOCKED" }] } })
        : Promise.resolve(0),
      canReadWork
        ? db.workOrder.count({ where: { AND: [baseWork, { dueAt: { lt: now } }] } })
        : Promise.resolve(0),
      canReadWork
        ? db.workOrder.count({
            where: { AND: [baseWork, { dueAt: { gte: now, lte: through } }] },
          })
        : Promise.resolve(0),
      canReadWork
        ? db.workOrder.count({ where: { AND: [baseWork, { priority: "URGENT" }] } })
        : Promise.resolve(0),
      canReadWork
        ? db.workOrder.findMany({
            where: baseWork,
            select: {
              id: true,
              number: true,
              title: true,
              status: true,
              priority: true,
              plannedStart: true,
              dueAt: true,
              asset: { select: { code: true } },
              team: { select: { name: true } },
            },
            orderBy: [{ dueAt: "asc" }, { priority: "desc" }, { requestedAt: "asc" }],
            take: PERSONAL_DASHBOARD_WORK_LIMIT,
          })
        : Promise.resolve([]),
      canApproveDocuments
        ? db.documentApproval.count({
            where: {
              approverId: input.userId,
              decision: "PENDING",
              revision: { document: { organizationId: input.organizationId } },
            },
          })
        : Promise.resolve(0),
      canApproveDocuments
        ? db.documentApproval.findMany({
            where: {
              approverId: input.userId,
              decision: "PENDING",
              revision: { document: { organizationId: input.organizationId } },
            },
            select: {
              id: true,
              revision: {
                select: {
                  revision: true,
                  document: { select: { id: true, code: true, title: true } },
                },
              },
            },
            take: PERSONAL_DASHBOARD_APPROVAL_LIMIT,
          })
        : Promise.resolve([]),
    ]);

  return {
    metrics: {
      openWork,
      blockedWork,
      overdueWork,
      dueSoonWork,
      urgentWork,
      pendingApprovals: approvalCount,
    },
    workOrders,
    approvals: approvals.map((approval) => ({
      id: approval.id,
      documentId: approval.revision.document.id,
      code: approval.revision.document.code,
      title: approval.revision.document.title,
      revision: approval.revision.revision,
    })),
  };
}
