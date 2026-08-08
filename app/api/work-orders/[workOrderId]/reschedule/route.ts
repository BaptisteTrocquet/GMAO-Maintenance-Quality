import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { reschedulePlanningDates } from "@/lib/maintenance/planning-calendar";

const schema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ workOrderId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid work-order reschedule payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "work:manage");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const { workOrderId } = await params;
  const [site, workOrder] = await Promise.all([
    db.site.findFirst({
      where: {
        id: parsed.data.siteId,
        organizationId: parsed.data.organizationId,
        active: true,
      },
      select: {
        id: true,
        organization: { select: { timezone: true } },
      },
    }),
    db.workOrder.findFirst({
      where: {
        id: workOrderId,
        siteId: parsed.data.siteId,
        site: { organizationId: parsed.data.organizationId, active: true },
      },
    }),
  ]);
  if (!site || !workOrder) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }
  if (workOrder.status === "COMPLETED" || workOrder.status === "CANCELLED") {
    return apiError(409, "WORK_ORDER_NOT_RESCHEDULABLE", "Completed or cancelled work orders cannot be rescheduled");
  }

  let dates: ReturnType<typeof reschedulePlanningDates>;
  try {
    dates = reschedulePlanningDates({
      plannedStart: workOrder.plannedStart,
      dueAt: workOrder.dueAt,
      targetDate: parsed.data.targetDate,
      timeZone: site.organization.timezone,
    });
  } catch {
    return apiError(400, "INVALID_PLANNING_DATE", "Target date is not valid in the organization timezone");
  }
  if (dates.dueAt && dates.dueAt.getTime() < dates.plannedStart.getTime()) {
    return apiError(400, "INVALID_PLANNING", "Rescheduling would place dueAt before plannedStart");
  }

  const updated = await db.workOrder.update({
    where: { id: workOrder.id },
    data: {
      plannedStart: dates.plannedStart,
      dueAt: dates.dueAt,
    },
  });
  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "WorkOrder",
      entityId: workOrder.id,
      action: "RESCHEDULED",
      beforeJson: JSON.stringify({
        plannedStart: workOrder.plannedStart,
        dueAt: workOrder.dueAt,
      }),
      afterJson: JSON.stringify({
        plannedStart: updated.plannedStart,
        dueAt: updated.dueAt,
        targetDate: parsed.data.targetDate,
        timeZone: site.organization.timezone,
      }),
    },
  });

  return apiData(updated);
}
