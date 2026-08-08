import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  localClockTime,
  ReschedulingTimeError,
  zonedDateTimeToUtc,
} from "@/lib/maintenance/rescheduling";

const rescheduleSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function accessError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workOrderId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = rescheduleSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid reschedule payload", parsed.error.flatten());
  }

  const { workOrderId } = await context.params;
  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  const existing = await db.workOrder.findFirst({
    where: {
      id: workOrderId,
      siteId: parsed.data.siteId,
      site: { organizationId: parsed.data.organizationId, active: true },
    },
    select: {
      id: true,
      number: true,
      siteId: true,
      status: true,
      plannedStart: true,
      dueAt: true,
      site: { select: { organization: { select: { timezone: true } } } },
    },
  });
  if (!existing) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  try {
    assertSitePermission(auth.tenant.scope, existing.siteId, "work:manage");
  } catch (error) {
    return accessError(error);
  }

  if (existing.status === "COMPLETED" || existing.status === "CANCELLED") {
    return apiError(
      409,
      "WORK_ORDER_NOT_RESCHEDULABLE",
      "Completed or cancelled work orders cannot be rescheduled",
    );
  }

  const timeZone = existing.site.organization.timezone;
  const localTime = existing.plannedStart
    ? localClockTime(existing.plannedStart, timeZone)
    : "09:00";

  let plannedStart: Date;
  try {
    plannedStart = zonedDateTimeToUtc(parsed.data.dateKey, localTime, timeZone);
  } catch (error) {
    if (error instanceof ReschedulingTimeError) {
      return apiError(400, error.code, error.message);
    }
    throw error;
  }

  if (existing.dueAt && plannedStart.getTime() > existing.dueAt.getTime()) {
    return apiError(
      409,
      "PLANNED_AFTER_DUE",
      "The planned start cannot be moved after the work-order due date",
    );
  }

  if (existing.plannedStart?.getTime() === plannedStart.getTime()) {
    return apiData({ ...existing, plannedStart });
  }

  const updated = await db.workOrder.update({
    where: { id: existing.id },
    data: { plannedStart },
  });

  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "WorkOrder",
      entityId: existing.id,
      action: "RESCHEDULED",
      beforeJson: JSON.stringify({ plannedStart: existing.plannedStart }),
      afterJson: JSON.stringify({
        plannedStart: updated.plannedStart,
        dateKey: parsed.data.dateKey,
        localTime,
        timeZone,
      }),
    },
  });

  return apiData(updated);
}
