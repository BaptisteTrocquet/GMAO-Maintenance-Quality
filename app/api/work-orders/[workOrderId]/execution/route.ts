import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

const updateSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  laborMinutes: z.number().int().min(0).nullable().optional(),
  downtimeMinutes: z.number().int().min(0).nullable().optional(),
  completionNote: z.string().max(5000).nullable().optional(),
  checklistAdd: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  checklistUpdates: z
    .array(
      z.object({
        id: z.string().min(1),
        completed: z.boolean().optional(),
        note: z.string().max(2000).nullable().optional(),
      }),
    )
    .max(100)
    .optional(),
});

function hasOwn(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

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
    include: { checkItems: true, assignee: true },
  });
  if (!workOrder) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  return apiData(workOrder);
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid execution payload", parsed.error.flatten());
  }

  const hasExecutionFields = ["laborMinutes", "downtimeMinutes", "completionNote"].some((field) =>
    hasOwn(parsed.data, field),
  );
  const hasChecklistAdd = Boolean(parsed.data.checklistAdd?.length);
  const hasChecklistUpdates = Boolean(parsed.data.checklistUpdates?.length);
  if (!hasExecutionFields && !hasChecklistAdd && !hasChecklistUpdates) {
    return apiError(400, "NO_CHANGES", "At least one execution field must change");
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  const { workOrderId } = await context.params;
  const existing = await db.workOrder.findFirst({
    where: {
      id: workOrderId,
      siteId: parsed.data.siteId,
      site: { organizationId: parsed.data.organizationId, active: true },
    },
    include: { checkItems: true },
  });
  if (!existing) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  if (existing.status !== "IN_PROGRESS" && existing.status !== "BLOCKED") {
    return apiError(
      409,
      "WORK_NOT_ACTIVE",
      "Execution can only be recorded while the work order is in progress or blocked",
    );
  }

  if (hasChecklistAdd) {
    try {
      assertSitePermission(auth.tenant.scope, existing.siteId, "work:manage");
    } catch (error) {
      return denied(error);
    }
  }

  if (hasExecutionFields || hasChecklistUpdates) {
    try {
      assertSitePermission(auth.tenant.scope, existing.siteId, "work:update");
    } catch (error) {
      return denied(error);
    }

    if (
      !can(auth.tenant.scope.role, "work:manage") &&
      existing.assigneeId !== auth.session.user.id
    ) {
      return apiError(
        403,
        "NOT_ASSIGNED",
        "Only the assigned technician can record work-order execution",
      );
    }
  }

  if (parsed.data.checklistUpdates?.length) {
    const existingIds = new Set(existing.checkItems.map((item) => item.id));
    if (parsed.data.checklistUpdates.some((item) => !existingIds.has(item.id))) {
      return apiError(404, "CHECK_ITEM_NOT_FOUND", "Checklist item not found on this work order");
    }
  }

  const transaction = [];
  if (hasExecutionFields) {
    transaction.push(
      db.workOrder.update({
        where: { id: existing.id },
        data: {
          ...(hasOwn(parsed.data, "laborMinutes")
            ? { laborMinutes: parsed.data.laborMinutes ?? null }
            : {}),
          ...(hasOwn(parsed.data, "downtimeMinutes")
            ? { downtimeMinutes: parsed.data.downtimeMinutes ?? null }
            : {}),
          ...(hasOwn(parsed.data, "completionNote")
            ? { completionNote: parsed.data.completionNote ?? null }
            : {}),
        },
      }),
    );
  }

  if (parsed.data.checklistAdd?.length) {
    transaction.push(
      db.workOrderCheckItem.createMany({
        data: parsed.data.checklistAdd.map((label) => ({ workOrderId: existing.id, label })),
      }),
    );
  }

  for (const item of parsed.data.checklistUpdates ?? []) {
    transaction.push(
      db.workOrderCheckItem.update({
        where: { id: item.id },
        data: {
          ...(item.completed !== undefined ? { completed: item.completed } : {}),
          ...(hasOwn(item, "note") ? { note: item.note ?? null } : {}),
        },
      }),
    );
  }

  await db.$transaction(transaction);
  const updated = await db.workOrder.findFirst({
    where: { id: existing.id },
    include: { checkItems: true, assignee: true },
  });

  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "WorkOrder",
      entityId: existing.id,
      action: hasChecklistAdd && !hasExecutionFields && !hasChecklistUpdates
        ? "CHECKLIST_CONFIGURED"
        : "EXECUTION_UPDATED",
      beforeJson: JSON.stringify(existing),
      afterJson: JSON.stringify(updated),
    },
  });

  return apiData(updated);
}
