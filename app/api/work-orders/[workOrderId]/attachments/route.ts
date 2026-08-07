import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  fileName: z.string().trim().min(1).max(255),
  storageKey: z.string().trim().min(1).max(1000),
  mimeType: z.string().trim().max(255).nullable().optional(),
  sizeBytes: z.number().int().min(0).nullable().optional(),
  kind: z.enum(["ATTACHMENT", "PHOTO"]).default("ATTACHMENT"),
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
    select: { id: true, siteId: true, status: true, assigneeId: true },
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
    await db.workOrderAttachment.findMany({
      where: { workOrderId: workOrder.id },
      orderBy: { createdAt: "desc" },
    }),
  );
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

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid attachment payload", parsed.error.flatten());
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
    !can(auth.tenant.scope.role, "work:manage") &&
    workOrder.assigneeId !== auth.session.user.id
  ) {
    return apiError(403, "NOT_ASSIGNED", "Only the assigned technician can add attachments");
  }

  if (workOrder.status === "CANCELLED") {
    return apiError(409, "WORK_CANCELLED", "Attachments cannot be added to a cancelled work order");
  }

  const attachment = await db.workOrderAttachment.create({
    data: {
      workOrderId: workOrder.id,
      fileName: parsed.data.fileName,
      storageKey: parsed.data.storageKey,
      mimeType: parsed.data.mimeType ?? null,
      sizeBytes: parsed.data.sizeBytes ?? null,
      kind: parsed.data.kind,
      createdBy: auth.session.user.id,
    },
  });

  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "WorkOrder",
      entityId: workOrder.id,
      action: "ATTACHMENT_ADDED",
      afterJson: JSON.stringify(attachment),
    },
  });

  return apiData(attachment, { status: 201 });
}
