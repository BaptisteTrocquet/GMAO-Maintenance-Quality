import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { rescheduleWorkOrderDates } from "@/lib/maintenance/calendar-reschedule";

const MAX_TRANSACTION_ATTEMPTS = 4;

const schema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function rescheduleErrorResponse(error: RescheduleError) {
  if (error.code === "WORK_ORDER_NOT_FOUND") return apiError(404, error.code, error.message);
  if (error.code === "INVALID_PLANNING_DATE" || error.code === "INVALID_PLANNING") {
    return apiError(400, error.code, error.message);
  }
  return apiError(409, error.code, error.message);
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

  const site = await db.site.findFirst({
    where: {
      id: parsed.data.siteId,
      organizationId: parsed.data.organizationId,
      active: true,
    },
    select: { organization: { select: { timezone: true } } },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Site not found in organization scope");

  const { workOrderId } = await params;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
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
            throw new RescheduleError("WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
          }
          if (workOrder.status === "COMPLETED" || workOrder.status === "CANCELLED") {
            throw new RescheduleError(
              "WORK_ORDER_NOT_RESCHEDULABLE",
              "Completed or cancelled work orders cannot be rescheduled",
            );
          }

          let dates: ReturnType<typeof rescheduleWorkOrderDates>;
          try {
            dates = rescheduleWorkOrderDates({
              plannedStart: workOrder.plannedStart,
              dueAt: workOrder.dueAt,
              targetDateKey: parsed.data.targetDate,
              timeZone: site.organization.timezone,
            });
          } catch {
            throw new RescheduleError(
              "INVALID_PLANNING_DATE",
              "Target date is not valid in the organization timezone",
            );
          }

          if (dates.dueAt && dates.dueAt.getTime() < dates.plannedStart.getTime()) {
            throw new RescheduleError(
              "INVALID_PLANNING",
              "Rescheduling would place dueAt before plannedStart",
            );
          }

          const saved = await tx.workOrder.update({
            where: { id: workOrder.id },
            data: { plannedStart: dates.plannedStart, dueAt: dates.dueAt },
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
                targetDate: parsed.data.targetDate,
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
      if (error instanceof RescheduleError) return rescheduleErrorResponse(error);
      lastError = error;
      if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }

  throw lastError;
}
