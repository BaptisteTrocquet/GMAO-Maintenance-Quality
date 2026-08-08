import { Buffer } from "node:buffer";
import { apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import {
  detectWorkOrderPhotoMimeType,
  workOrderAttachmentStoragePrefix,
} from "@/lib/work-orders/attachment-policy";

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workOrderId: string; attachmentId: string }> },
) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;

  const { workOrderId, attachmentId } = await context.params;
  const workOrder = await db.workOrder.findFirst({
    where: { id: workOrderId, siteId, site: { organizationId, active: true } },
    select: {
      id: true,
      siteId: true,
      site: { select: { organizationId: true } },
    },
  });
  if (!workOrder) {
    return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  try {
    assertSitePermission(auth.tenant.scope, workOrder.siteId, "work:read");
  } catch (error) {
    return denied(error);
  }

  const attachment = await db.workOrderAttachment.findFirst({
    where: { id: attachmentId, workOrderId: workOrder.id },
    select: {
      id: true,
      fileName: true,
      storageKey: true,
      mimeType: true,
      sizeBytes: true,
      kind: true,
    },
  });
  if (!attachment) {
    return apiError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found on this work order");
  }

  const expectedPrefix = `${workOrderAttachmentStoragePrefix({
    organizationId: workOrder.site.organizationId,
    siteId: workOrder.siteId,
    workOrderId: workOrder.id,
  })}/`;
  if (!attachment.storageKey.startsWith(expectedPrefix)) {
    return apiError(404, "FILE_NOT_AVAILABLE", "Stored attachment file is not available");
  }

  let data: Uint8Array;
  try {
    data = await storage.get(attachment.storageKey);
  } catch {
    return apiError(404, "FILE_NOT_AVAILABLE", "Stored attachment file is not available");
  }

  const detectedMimeType = detectWorkOrderPhotoMimeType(data);
  const inlinePhoto = attachment.kind === "PHOTO" && detectedMimeType !== null;
  const contentType = inlinePhoto ? detectedMimeType : "application/octet-stream";
  const disposition = inlinePhoto ? "inline" : "attachment";

  return new Response(Buffer.from(data), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      "Content-Length": data.byteLength.toString(),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
