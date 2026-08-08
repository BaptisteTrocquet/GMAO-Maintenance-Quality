import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { movePlannedStartToDate } from "@/lib/maintenance/planning-calendar";

const schema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  targetDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

class RescheduleError extends Error {
  constructor(
    public readonly code:
      | "WORK_ORDER_NOT_FOUND"
      | "WORK_ORDER_NOT_RESCHEDULABLE"
      | "INVALID_PLANNING_DATE"
      | "INVALID_PLANNING",
    message: string,
  ) {
    super(message);
    this.name = "RescheduleError";
  }
}

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
  const site = await db.site.findFirst({
    where: {
      id: parsed.data.siteId,
      organizationId: parsed.data.organizationId,
      active: true,
    },
    select: {
      id: true,
      organization: { select: { timezone: true } },
    },
  });
  if (!site) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  try {
    const updated = await db.$transaction(
      async (tx) => {
        const workOrder = await tx.workOrder.findFirst({
          where: {
            id: workOrderId,
            siteId: parsed.data.siteId,
            site: { organizationId: parsed.data.organizationId, active: true },
          },
        });
        if (!workOrder) {
          throw new RescheduleError(
            "WORK_ORDER_NOT_FOUND",
            "Work order not found in site scope",
          );
        }
        if (workOrder.status === "COMPLETED" || workOrder.status === "CANCELLED") {
          throw new RescheduleError(
            "WORK_ORDER_NOT_RESCHEDULABLE",
            "Completed or cancelled work orders cannot be rescheduled",
          );
        }

        let plannedStart: Date;
        try {
          plannedStart = movePlannedStartToDate({
            plannedStart: workOrder.plannedStart,
            targetDateKey: parsed.data.targetDateKey,
            timeZone: site.organization.timezone,
          });
        } catch {
          throw new RescheduleError(
            "INVALID_PLANNING_DATE",
            "Target date is not valid in the organization timezone",
          );
        }

        if (
          workOrder.plannedStart &&
          workOrder.plannedStart.getTime() === plannedStart.getTime()
        ) {
          return workOrder;
        }

        if (workOrder.dueAt && workOrder.dueAt.getTime() < plannedStart.getTime()) {
          throw new RescheduleError(
            "INVALID_PLANNING",
            "Rescheduling would place plannedStart after the existing due date",
          );
        }

        const saved = await tx.workOrder.update({
          where: { id: workOrder.id },
          data: { plannedStart },
        });
        await tx.auditLog.create({
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
              plannedStart: saved.plannedStart,
              dueAt: saved.dueAt,
              targetDateKey: parsed.data.targetDateKey,
              timeZone: site.organization.timezone,
            }),
          },
        });
        return saved;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return apiData(updated);
  } catch (error) {
    if (error instanceof RescheduleError) {
      const status = error.code === "WORK_ORDER_NOT_FOUND" ? 404 : 409;
      return apiError(status, error.code, error.message);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return apiError(
        409,
        "RESCHEDULE_CONFLICT",
        "The work order changed concurrently; refresh the calendar and retry",
      );
    }
    throw error;
  }
}
