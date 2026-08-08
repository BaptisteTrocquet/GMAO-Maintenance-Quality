import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  attachQualityEvidence,
  listQualityEvidence,
  MAX_QUALITY_EVIDENCE_BYTES,
  QualityEvidenceError,
} from "@/lib/quality/evidence";

function scopeFromRequest(request: Request) {
  const url = new URL(request.url);
  return {
    organizationId: url.searchParams.get("organizationId") ?? "",
    siteId: url.searchParams.get("siteId") ?? "",
  };
}

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
      : error.code === "FILE_TOO_LARGE"
        ? 413
        : 409;
  return apiError(status, error.code, error.message);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const { organizationId, siteId } = scopeFromRequest(request);
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, siteId, "quality:read");
  if (denied) return denied;

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
  const { organizationId, siteId } = scopeFromRequest(request);
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, siteId, "quality:manage");
  if (denied) return denied;

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_QUALITY_EVIDENCE_BYTES + 1024 * 1024) {
    return apiError(413, "FILE_TOO_LARGE", `Quality evidence file cannot exceed ${MAX_QUALITY_EVIDENCE_BYTES} bytes`);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError(400, "INVALID_MULTIPART", "Request must contain multipart form data");
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return apiError(400, "FILE_REQUIRED", "A quality evidence file is required");
  }
  const kind = form.get("kind");
  const description = form.get("description");

  try {
    const evidence = await attachQualityEvidence({
      organizationId,
      siteId,
      eventId,
      actorId: auth.session.user.id,
      fileName: file.name,
      mimeType: file.type || null,
      kind: typeof kind === "string" ? kind.slice(0, 100) : null,
      description: typeof description === "string" ? description.slice(0, 2000) : null,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    return apiData(evidence, { status: 201 });
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}
