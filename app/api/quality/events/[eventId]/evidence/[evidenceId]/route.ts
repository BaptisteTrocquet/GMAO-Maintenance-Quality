import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { QualityEvidenceError, revokeQualityEvidence } from "@/lib/quality/evidence";

const revokeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  reason: z.string().trim().min(1).max(5000),
});

function evidenceError(error: QualityEvidenceError) {
  if (error.code === "QUALITY_EVENT_NOT_FOUND" || error.code === "EVIDENCE_NOT_FOUND") {
    return apiError(404, error.code, error.message);
  }
  if (error.code === "REVOKE_REASON_REQUIRED" || error.code === "INVALID_FILE_METADATA") {
    return apiError(400, error.code, error.message);
  }
  return apiError(409, error.code, error.message);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ eventId: string; evidenceId: string }> },
) {
  const { eventId, evidenceId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid evidence revocation payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  try {
    return apiData(
      await revokeQualityEvidence({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        evidenceId,
        reason: parsed.data.reason,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}
