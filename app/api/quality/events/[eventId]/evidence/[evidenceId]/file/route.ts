import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  QualityEvidenceError,
  readQualityEvidence,
  removeQualityEvidence,
} from "@/lib/quality/evidence";

function authorize(
  scope: Parameters<typeof assertSitePermission>[0],
  siteId: string,
  permission: "quality:read" | "quality:manage",
) {
  try {
    assertSitePermission(scope, siteId, permission);
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

function evidenceError(error: QualityEvidenceError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" || error.code === "EVIDENCE_NOT_FOUND"
      ? 404
      : error.code === "FILE_INTEGRITY_FAILED"
        ? 409
        : 409;
  return apiError(status, error.code, error.message);
}

function safeContentDisposition(fileName: string) {
  const safe = fileName.replace(/[\r\n"]/g, "_");
  return `attachment; filename="${safe}"`;
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
  const denied = authorize(auth.tenant.scope, siteId, "quality:read");
  if (denied) return denied;

  try {
    const evidence = await readQualityEvidence({ organizationId, siteId, eventId, evidenceId });
    return new Response(evidence.data, {
      status: 200,
      headers: {
        "content-type": evidence.mimeType || "application/octet-stream",
        "content-length": String(evidence.sizeBytes),
        "content-disposition": safeContentDisposition(evidence.fileName),
        "x-content-sha256": evidence.checksum,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}

export async function DELETE(
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
  const denied = authorize(auth.tenant.scope, siteId, "quality:manage");
  if (denied) return denied;

  try {
    return apiData(
      await removeQualityEvidence({
        organizationId,
        siteId,
        eventId,
        evidenceId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}
