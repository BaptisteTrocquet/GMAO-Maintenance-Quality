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

function parseAuditJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
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
    select: { id: true },
  });
  if (!workOrder) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  const events = await db.auditLog.findMany({
    where: { entityType: "WorkOrder", entityId: workOrder.id },
    include: { actor: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
  });

  return apiData(
    events.map((event) => ({
      id: event.id,
      action: event.action,
      createdAt: event.createdAt,
      actor: event.actor,
      before: parseAuditJson(event.beforeJson),
      after: parseAuditJson(event.afterJson),
    })),
  );
}
