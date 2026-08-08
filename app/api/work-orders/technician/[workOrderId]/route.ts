import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  OFFLINE_READ_PARTITION_HEADER,
  offlineReadPartitionFromAuthorization,
} from "@/lib/pwa/offline-read-cache";
import { canExecuteWorkOrder } from "@/lib/work-orders/authorization";

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workOrderId: string }> },
) {
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

  const { workOrderId } = await context.params;
  const workOrder = await db.workOrder.findFirst({
    where: { id: workOrderId, siteId, site: { organizationId, active: true } },
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
      laborMinutes: true,
      downtimeMinutes: true,
      completionNote: true,
      assigneeId: true,
      teamId: true,
      asset: { select: { id: true, code: true, name: true } },
      assignee: { select: { id: true, displayName: true } },
      team: { select: { id: true, name: true } },
      checkItems: {
        select: { id: true, label: true, completed: true, note: true },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!workOrder) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  const canExecute = await canExecuteWorkOrder({
    role: auth.tenant.scope.role,
    userId: auth.session.user.id,
    siteId,
    assigneeId: workOrder.assigneeId,
    teamId: workOrder.teamId,
  });
  if (!canExecute) {
    return apiError(
      403,
      "NOT_ASSIGNED",
      "This technician work order is not assigned to you or one of your teams",
    );
  }

  const response = apiData({ workOrder });
  const partition = offlineReadPartitionFromAuthorization(request.headers.get("authorization"));
  if (partition) response.headers.set(OFFLINE_READ_PARTITION_HEADER, partition);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
