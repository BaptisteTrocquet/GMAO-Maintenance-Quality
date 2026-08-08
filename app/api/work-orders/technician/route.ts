import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, siteId, "work:read");
  } catch (error) {
    return denied(error);
  }

  const teamMemberships = await db.maintenanceTeamMember.findMany({
    where: {
      userId: auth.session.user.id,
      user: { active: true },
      team: { siteId, active: true },
    },
    select: { teamId: true },
  });
  const teamIds = teamMemberships.map((membership) => membership.teamId);

  const workOrders = await db.workOrder.findMany({
    where: {
      siteId,
      site: { organizationId, active: true },
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      OR: [
        { assigneeId: auth.session.user.id },
        ...(teamIds.length ? [{ teamId: { in: teamIds } }] : []),
      ],
    },
    select: {
      id: true,
      number: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      type: true,
      plannedStart: true,
      dueAt: true,
      startedAt: true,
      updatedAt: true,
      asset: { select: { id: true, code: true, name: true } },
      assignee: { select: { id: true, displayName: true } },
      team: { select: { id: true, name: true } },
      _count: { select: { checkItems: true, attachments: true } },
    },
    orderBy: [{ dueAt: "asc" }, { priority: "desc" }, { updatedAt: "desc" }],
  });

  return apiData({ workOrders });
}
