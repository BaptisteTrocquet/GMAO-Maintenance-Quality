import { apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { QualityEvidenceError, readQualityEvidence } from "@/lib/quality/evidence";

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

function evidenceError(error: QualityEvidenceError) {
  if (error.code === "QUALITY_EVENT_NOT_FOUND" || error.code === "EVIDENCE_NOT_FOUND") {
    return apiError(404, error.code, error.message);
  }
  if (error.code === "FILE_INTEGRITY_FAILED") {
    return apiError(409, error.code, error.message);
  }
  return apiError(400, error.code, error.message);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string; evidenceId: string }> },
) {
  const { eventId, evidenceId } = await params;
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, siteId, "quality:read");
  } catch (error) {
    return denied(error);
  }

  try {
    const evidence = await readQualityEvidence({
      organizationId,
      siteId,
      eventId,
      evidenceId,
    });
    const encodedName = encodeURIComponent(evidence.fileName);
    return new Response(Buffer.from(evidence.data), {
      status: 200,
      headers: {
        "content-type": evidence.mimeType ?? "application/octet-stream",
        "content-length": String(evidence.sizeBytes),
        "content-disposition": `attachment; filename*=UTF-8''${encodedName}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}
