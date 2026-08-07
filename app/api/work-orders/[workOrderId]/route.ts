import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { can, type Permission } from "@/lib/permissions";
import {
  assertTransitionRequirements,
  deriveTransitionDates,
  transitionPermission,
  WorkOrderWorkflowError,
} from "@/lib/work-orders/workflow";

const updateSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  status: z
    .enum([
      "REQUESTED",
      "APPROVED",
      "PLANNED",
      "IN_PROGRESS",
      "BLOCKED",
      "COMPLETED",
      "CANCELLED",
    ])
    .optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  type: z
    .enum(["CORRECTIVE", "PREVENTIVE", "INSPECTION", "IMPROVEMENT", "SAFETY", "OTHER"])
    .optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  plannedStart: z.coerce.date().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  statusNote: z.string().max(1000).nullable().optional(),
});

function hasOwn(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function accessError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
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

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid work order update", parsed.error.flatten());
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
    include: { checkItems: { select: { id: true, completed: true } } },
  });
  if (!existing) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  const triageFields = ["priority", "type", "assigneeId", "plannedStart", "dueAt"];
  const hasTriageUpdate = triageFields.some((field) => hasOwn(parsed.data, field));
  const hasStatusTransition = parsed.data.status !== undefined && parsed.data.status !== existing.status;

  if (!hasTriageUpdate && !hasStatusTransition) {
    return apiError(400, "NO_CHANGES", "At least one work order field must change");
  }

  if (hasTriageUpdate) {
    try {
      assertSitePermission(auth.tenant.scope, existing.siteId, "work:manage");
    } catch (error) {
      return accessError(error);
    }
  }

  let requiredStatusPermission: Permission | null = null;
  if (hasStatusTransition && parsed.data.status) {
    try {
      requiredStatusPermission = transitionPermission(existing.status, parsed.data.status);
      assertSitePermission(auth.tenant.scope, existing.siteId, requiredStatusPermission);
    } catch (error) {
      if (error instanceof WorkOrderWorkflowError) {
        return apiError(409, error.code, error.message);
      }
      return accessError(error);
    }

    if (
      requiredStatusPermission === "work:update" &&
      !can(auth.tenant.scope.role, "work:manage") &&
      existing.assigneeId !== auth.session.user.id
    ) {
      return apiError(
        403,
        "NOT_ASSIGNED",
        "Only the assigned technician can execute this work order",
      );
    }
  }

  if (hasOwn(parsed.data, "assigneeId") && parsed.data.assigneeId) {
    const membership = await db.organizationMembership.findFirst({
      where: {
        organizationId: parsed.data.organizationId,
        userId: parsed.data.assigneeId,
        active: true,
        role: { in: ["OWNER", "ADMIN", "MAINTENANCE_MANAGER", "TECHNICIAN"] },
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId: existing.siteId } } }],
      },
      select: { id: true },
    });
    if (!membership) {
      return apiError(
        404,
        "ASSIGNEE_NOT_FOUND",
        "Assignee is not an active maintenance member for this site",
      );
    }
  }

  const plannedStart = hasOwn(parsed.data, "plannedStart")
    ? (parsed.data.plannedStart ?? null)
    : existing.plannedStart;
  const dueAt = hasOwn(parsed.data, "dueAt") ? (parsed.data.dueAt ?? null) : existing.dueAt;

  if (plannedStart && dueAt && dueAt.getTime() < plannedStart.getTime()) {
    return apiError(400, "INVALID_PLANNING", "dueAt cannot be earlier than plannedStart");
  }

  const data: Prisma.WorkOrderUncheckedUpdateInput = {};
  if (parsed.data.priority !== undefined) data.priority = parsed.data.priority;
  if (parsed.data.type !== undefined) data.type = parsed.data.type;
  if (hasOwn(parsed.data, "assigneeId")) data.assigneeId = parsed.data.assigneeId ?? null;
  if (hasOwn(parsed.data, "plannedStart")) data.plannedStart = parsed.data.plannedStart ?? null;
  if (hasOwn(parsed.data, "dueAt")) data.dueAt = parsed.data.dueAt ?? null;

  let signedAt: Date | null = null;
  if (hasStatusTransition && parsed.data.status) {
    try {
      assertTransitionRequirements({
        from: existing.status,
        to: parsed.data.status,
        plannedStart,
      });
    } catch (error) {
      if (error instanceof WorkOrderWorkflowError) {
        return apiError(409, error.code, error.message);
      }
      throw error;
    }

    if (parsed.data.status === "COMPLETED") {
      if (!existing.completionNote?.trim()) {
        return apiError(
          409,
          "COMPLETION_NOTE_REQUIRED",
          "A completion note is required before closing the work order",
        );
      }
      if (existing.checkItems.some((item) => !item.completed)) {
        return apiError(
          409,
          "CHECKLIST_INCOMPLETE",
          "All work-order checklist items must be completed before closing",
        );
      }
    }

    const dates = deriveTransitionDates({
      from: existing.status,
      to: parsed.data.status,
      startedAt: existing.startedAt,
      completedAt: existing.completedAt,
    });
    data.status = parsed.data.status;
    data.startedAt = dates.startedAt;
    data.completedAt = dates.completedAt;
    signedAt = parsed.data.status === "COMPLETED" ? dates.completedAt : null;
  }

  const updated = await db.workOrder.update({ where: { id: existing.id }, data });
  const completedWithSignature = parsed.data.status === "COMPLETED" && signedAt;
  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "WorkOrder",
      entityId: existing.id,
      action: completedWithSignature
        ? "COMPLETED_SIGNED"
        : hasStatusTransition
          ? "STATUS_CHANGED"
          : "TRIAGED",
      beforeJson: JSON.stringify(existing),
      afterJson: JSON.stringify({
        workOrder: updated,
        note: parsed.data.statusNote ?? null,
        ...(completedWithSignature
          ? { signature: { signedById: auth.session.user.id, signedAt } }
          : {}),
      }),
    },
  });

  return apiData(updated);
}
