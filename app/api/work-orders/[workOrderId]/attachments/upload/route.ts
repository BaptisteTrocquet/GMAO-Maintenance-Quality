import { createHash, randomUUID } from "node:crypto";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { canExecuteWorkOrder } from "@/lib/work-orders/authorization";
import {
  detectWorkOrderPhotoMimeType,
  isWorkOrderPhotoMimeType,
  MAX_WORK_ORDER_PHOTO_BYTES,
  workOrderAttachmentStoragePrefix,
} from "@/lib/work-orders/attachment-policy";

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

function cleanFileName(value: string) {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "camera-photo").slice(0, 255);
}

async function findWorkOrder(organizationId: string, siteId: string, workOrderId: string) {
  return db.workOrder.findFirst({
    where: { id: workOrderId, siteId, site: { organizationId, active: true } },
    select: {
      id: true,
      siteId: true,
      status: true,
      assigneeId: true,
      teamId: true,
      site: { select: { organizationId: true } },
    },
  });
}

export async function POST(
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

  const { workOrderId } = await context.params;
  const workOrder = await findWorkOrder(organizationId, siteId, workOrderId);
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
      "Only the assigned technician or an assigned team member can add photos",
    );
  }

  if (workOrder.status === "CANCELLED") {
    return apiError(409, "WORK_CANCELLED", "Photos cannot be added to a cancelled work order");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return apiError(400, "INVALID_MULTIPART", "Request body must be multipart/form-data");
  }

  const uploaded = formData.get("file");
  if (!(uploaded instanceof File)) {
    return apiError(400, "FILE_REQUIRED", "A photo file is required");
  }

  const declaredMimeType = uploaded.type.toLowerCase();
  if (!isWorkOrderPhotoMimeType(declaredMimeType)) {
    return apiError(415, "UNSUPPORTED_PHOTO_TYPE", "Photo must be JPEG, PNG, or WebP");
  }
  if (uploaded.size === 0) {
    return apiError(400, "FILE_REQUIRED", "Photo cannot be empty");
  }
  if (uploaded.size > MAX_WORK_ORDER_PHOTO_BYTES) {
    return apiError(
      413,
      "PHOTO_TOO_LARGE",
      `Photo cannot exceed ${MAX_WORK_ORDER_PHOTO_BYTES} bytes`,
    );
  }

  const data = new Uint8Array(await uploaded.arrayBuffer());
  const detectedMimeType = detectWorkOrderPhotoMimeType(data);
  if (!detectedMimeType || detectedMimeType !== declaredMimeType) {
    return apiError(
      415,
      "PHOTO_CONTENT_MISMATCH",
      "Photo content does not match its declared image type",
    );
  }

  const storagePrefix = workOrderAttachmentStoragePrefix({
    organizationId: workOrder.site.organizationId,
    siteId: workOrder.siteId,
    workOrderId: workOrder.id,
  });
  const checksum = createHash("sha256").update(data).digest("hex");
  const storageKey = `${storagePrefix}/${randomUUID()}-${checksum.slice(0, 16)}`;
  await storage.put(storageKey, data);

  try {
    const attachment = await db.$transaction(async (tx) => {
      const created = await tx.workOrderAttachment.create({
        data: {
          workOrderId: workOrder.id,
          fileName: cleanFileName(uploaded.name),
          storageKey,
          mimeType: detectedMimeType,
          sizeBytes: data.byteLength,
          kind: "PHOTO",
          createdBy: auth.session.user.id,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: auth.session.user.id,
          entityType: "WorkOrder",
          entityId: workOrder.id,
          action: "PHOTO_ADDED",
          afterJson: JSON.stringify({
            attachmentId: created.id,
            fileName: created.fileName,
            mimeType: created.mimeType,
            sizeBytes: created.sizeBytes,
          }),
        },
      });
      return created;
    });

    return apiData(attachment, { status: 201 });
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
}
