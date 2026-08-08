import { Buffer } from "node:buffer";
import { apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { QualityEvidenceError, readQualityEvidence } from "@/lib/quality/evidence";

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
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
    return new Response(Buffer.from(evidence.data), {
      status: 200,
      headers: {
        "Content-Type": evidence.mimeType ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(evidence.fileName)}`,
        "Content-Length": evidence.data.byteLength.toString(),
        "X-Content-SHA256": evidence.checksum,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof QualityEvidenceError) {
      const status =
        error.code === "QUALITY_EVENT_NOT_FOUND" || error.code === "EVIDENCE_NOT_FOUND"
          ? 404
          : error.code === "FILE_INTEGRITY_FAILED"
            ? 409
            : 400;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
