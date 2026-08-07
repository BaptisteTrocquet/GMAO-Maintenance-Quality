import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { canExecuteWorkOrder } from "@/lib/work-orders/authorization";
import { consumeWorkOrderPart, WorkOrderPartError } from "@/lib/work-orders/parts";

const consumeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  partId: z.string().min(1),
  binId: z.string().min(1),
  quantity: z.number().positive().max(1_000_000),
});

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

async function findWorkOrder(organizationId: string, siteId: string, workOrderId: string) {
  return db.workOrder.findFirst({
    where: { id: workOrderId, siteId, site: { organizationId, active: true } },
    select: { id: true, siteId: true, status: true, assigneeId: true, teamId: true },
  });
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
  const workOrder = await findWorkOrder(organizationId, siteId, workOrderId);
  if (!workOrder) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  return apiData(
    await db.workOrderPartConsumption.findMany({
      where: { workOrderId: workOrder.id },
      include: { part: true, bin: { include: { warehouse: true } } },
      orderBy: { createdAt: "desc" },
    }),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workOrderId: string }> },
) {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return apiError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A unique Idempotency-Key header between 8 and 200 characters is required",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = consumeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid part consumption payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  const { workOrderId } = await context.params;
  const workOrder = await findWorkOrder(parsed.data.organizationId, parsed.data.siteId, workOrderId);
  if (!workOrder) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  try {
    assertSitePermission(auth.tenant.scope, workOrder.siteId, "work:update");
  } catch (error) {
    return denied(error);
  }

  if (
    !(await canExecuteWorkOrder({
      role: auth.tenant.scope.role,
      userId: auth.session.user.id,
      siteId: workOrder.siteId,
      assigneeId: workOrder.assigneeId,
      teamId: workOrder.teamId ?? null,
    }))
  ) {
    return apiError(
      403,
      "NOT_ASSIGNED",
      "Only the assigned technician or an assigned team member can consume parts",
    );
  }

  if (workOrder.status !== "IN_PROGRESS" && workOrder.status !== "BLOCKED") {
    return apiError(
      409,
      "WORK_NOT_ACTIVE",
      "Parts can only be consumed while the work order is in progress or blocked",
    );
  }

  try {
    const result = await consumeWorkOrderPart({
      organizationId: parsed.data.organizationId,
      siteId: workOrder.siteId,
      workOrderId: workOrder.id,
      partId: parsed.data.partId,
      binId: parsed.data.binId,
      quantity: parsed.data.quantity,
      idempotencyKey,
      actorId: auth.session.user.id,
    });
    return apiData(result, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    if (error instanceof WorkOrderPartError) {
      const status =
        error.code === "PART_NOT_FOUND" || error.code === "BIN_NOT_FOUND" ? 404 : 409;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
