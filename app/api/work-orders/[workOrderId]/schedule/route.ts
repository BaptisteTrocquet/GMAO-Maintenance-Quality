import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  rescheduleWorkOrder,
  WorkOrderRescheduleError,
} from "@/lib/work-orders/reschedule";

const scheduleSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  plannedStart: z.coerce.date(),
  dueAt: z.coerce.date().nullable(),
});

function statusFor(error: WorkOrderRescheduleError) {
  switch (error.code) {
    case "WORK_ORDER_NOT_FOUND":
      return 404;
    case "WORK_ORDER_NOT_RESCHEDULABLE":
      return 409;
    case "INVALID_PLANNING":
      return 400;
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ workOrderId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid work-order schedule", parsed.error.flatten());
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
    const { workOrderId } = await context.params;
    const result = await rescheduleWorkOrder({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      workOrderId,
      plannedStart: parsed.data.plannedStart,
      dueAt: parsed.data.dueAt,
      actorId: auth.session.user.id,
    });
    return apiData(result);
  } catch (error) {
    if (error instanceof WorkOrderRescheduleError) {
      return apiError(statusFor(error), error.code, error.message);
    }
    throw error;
  }
}
