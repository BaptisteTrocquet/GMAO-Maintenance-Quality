import { Buffer } from "node:buffer";
import { apiError } from "@/lib/api-response";
import { assertPermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  attachDocumentRevisionFile,
  DocumentFileError,
  readDocumentRevisionFile,
} from "@/lib/documents/files";

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
}

function organizationIdFrom(request: Request) {
  return new URL(request.url).searchParams.get("organizationId");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string; revisionId: string }> },
) {
  const organizationId = organizationIdFrom(request);
  if (!organizationId) return apiError(400, "INVALID_SCOPE", "organizationId is required");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertPermission(auth.tenant.scope, "document:manage");
  } catch (error) {
    return denied(error);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return apiError(400, "INVALID_MULTIPART", "Request body must be multipart/form-data");
  }

  const uploaded = formData.get("file");
  if (!(uploaded instanceof File)) {
    return apiError(400, "FILE_REQUIRED", "A file field is required");
  }

  const { documentId, revisionId } = await context.params;
  try {
    const updated = await attachDocumentRevisionFile({
      organizationId,
      documentId,
      revisionId,
      actorId: auth.session.user.id,
      fileName: uploaded.name || "controlled-document",
      mimeType: uploaded.type || null,
      data: new Uint8Array(await uploaded.arrayBuffer()),
    });
    return Response.json({ data: updated }, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentFileError) {
      const status =
        error.code === "REVISION_NOT_FOUND"
          ? 404
          : error.code === "REVISION_IMMUTABLE"
            ? 409
            : error.code === "FILE_TOO_LARGE"
              ? 413
              : 400;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string; revisionId: string }> },
) {
  const organizationId = organizationIdFrom(request);
  if (!organizationId) return apiError(400, "INVALID_SCOPE", "organizationId is required");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertPermission(auth.tenant.scope, "document:read");
  } catch (error) {
    return denied(error);
  }

  const { documentId, revisionId } = await context.params;
  try {
    const file = await readDocumentRevisionFile({ organizationId, documentId, revisionId });
    return new Response(Buffer.from(file.data), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        "Content-Length": file.data.byteLength.toString(),
        "X-Content-SHA256": file.checksum,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof DocumentFileError) {
      const status =
        error.code === "REVISION_NOT_FOUND" || error.code === "FILE_NOT_ATTACHED"
          ? 404
          : error.code === "FILE_INTEGRITY_FAILED"
            ? 409
            : 400;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
