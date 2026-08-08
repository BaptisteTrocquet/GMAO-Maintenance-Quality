import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  attachQualityEvidence,
  listQualityEvidence,
  QualityEvidenceError,
} from "@/lib/quality/evidence";

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
}

function evidenceError(error: QualityEvidenceError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" || error.code === "EVIDENCE_NOT_FOUND"
      ? 404
      : error.code === "EVENT_CLOSED" || error.code === "FILE_INTEGRITY_FAILED"
        ? 409
        : error.code === "FILE_TOO_LARGE"
          ? 413
          : 400;
  return apiError(status, error.code, error.message);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
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
    return apiData(await listQualityEvidence({ organizationId, siteId, eventId }));
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, siteId, "quality:manage");
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

  try {
    const evidence = await attachQualityEvidence({
      organizationId,
      siteId,
      eventId,
      actorId: auth.session.user.id,
      fileName: uploaded.name || "quality-evidence",
      mimeType: uploaded.type || null,
      kind: typeof formData.get("kind") === "string" ? String(formData.get("kind")) : null,
      description:
        typeof formData.get("description") === "string"
          ? String(formData.get("description"))
          : null,
      data: new Uint8Array(await uploaded.arrayBuffer()),
    });
    return apiData(evidence, { status: 201 });
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}
