import { Buffer } from "node:buffer";
import { AccessDeniedError, assertPermission } from "@/lib/access-control";
import { apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { ControlledCopyError, issueControlledCopy } from "@/lib/documents/controlled-copy";

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  if (!organizationId) return apiError(400, "INVALID_SCOPE", "organizationId is required");

  const rawAsOf = url.searchParams.get("asOf");
  const asOf = rawAsOf ? new Date(rawAsOf) : new Date();
  if (Number.isNaN(asOf.getTime())) return apiError(400, "INVALID_AS_OF", "asOf must be a valid date");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertPermission(auth.tenant.scope, "document:read");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const { documentId } = await context.params;
  try {
    const copy = await issueControlledCopy({
      organizationId,
      documentId,
      actorId: auth.session.user.id,
      asOf,
    });
    const effectiveAt = copy.revision.effectiveAt?.toISOString() ?? "";
    return new Response(Buffer.from(copy.file.data), {
      status: 200,
      headers: {
        "Content-Type": copy.file.mimeType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(copy.file.fileName)}`,
        "Content-Length": copy.file.data.byteLength.toString(),
        "Cache-Control": "private, no-store",
        "X-Controlled-Copy": "true",
        "X-Document-Code": copy.document.code,
        "X-Document-Revision": copy.revision.revision,
        "X-Document-Effective-At": effectiveAt,
        "X-Controlled-Copy-As-Of": copy.asOf.toISOString(),
        "X-Content-SHA256": copy.file.checksum,
      },
    });
  } catch (error) {
    if (error instanceof ControlledCopyError) {
      const status =
        error.code === "DOCUMENT_NOT_FOUND" || error.code === "EFFECTIVE_REVISION_NOT_FOUND"
          ? 404
          : 409;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
