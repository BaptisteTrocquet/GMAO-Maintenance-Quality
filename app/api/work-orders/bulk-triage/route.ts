import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  BULK_WORK_ORDER_LIMIT,
  bulkTriageWorkOrders,
  BulkWorkOrderError,
} from "@/lib/work-orders/bulk-triage";

const bodySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  workOrderIds: z.array(z.string().min(1)).min(1).max(BULK_WORK_ORDER_LIMIT),
  changes: z
    .object({
      priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
      plannedStart: z.coerce.date().nullable().optional(),
      dueAt: z.coerce.date().nullable().optional(),
    })
    .strict(),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid bulk work-order update", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "work:manage");
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return apiError(403, "ACCESS_DENIED", error.message);
    }
    throw error;
  }

  try {
    return apiData(
      await bulkTriageWorkOrders({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        workOrderIds: parsed.data.workOrderIds,
        changes: parsed.data.changes,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof BulkWorkOrderError) {
      const status = error.code === "WORK_ORDER_NOT_FOUND" ? 404 : error.code === "INVALID_PLANNING" ? 409 : 400;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
