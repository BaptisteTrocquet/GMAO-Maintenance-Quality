import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  attachQualityEvidence,
  listQualityEvidence,
  MAX_QUALITY_EVIDENCE_BYTES,
  QualityEvidenceError,
} from "@/lib/quality/evidence";

const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

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

function requestTooLarge(request: Request) {
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const length = Number(raw);
  return (
    Number.isFinite(length) &&
    length > MAX_QUALITY_EVIDENCE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
  );
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

  if (requestTooLarge(request)) {
    return apiError(
      413,
      "FILE_TOO_LARGE",
      `Quality evidence file cannot exceed ${MAX_QUALITY_EVIDENCE_BYTES} bytes`,
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return apiError(400, "INVALID_MULTIPART", "Request body must be multipart/form-data");
  }
  const uploaded = formData.get("file");
  if (!(uploaded instanceof File) || uploaded.size === 0) {
    return apiError(400, "FILE_REQUIRED", "A non-empty file field is required");
  }
  if (uploaded.size > MAX_QUALITY_EVIDENCE_BYTES) {
    return apiError(
      413,
      "FILE_TOO_LARGE",
      `Quality evidence file cannot exceed ${MAX_QUALITY_EVIDENCE_BYTES} bytes`,
    );
  }

  const kindValue = formData.get("kind");
  const descriptionValue = formData.get("description");
  const kind = typeof kindValue === "string" ? kindValue.trim() : "";
  const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";
  if (kind.length > 100 || description.length > 2000 || uploaded.name.length > 255) {
    return apiError(
      400,
      "INVALID_EVIDENCE_METADATA",
      "Evidence name, kind or description exceeds the allowed length",
    );
  }

  try {
    const evidence = await attachQualityEvidence({
      organizationId,
      siteId,
      eventId,
      actorId: auth.session.user.id,
      fileName: uploaded.name || "quality-evidence",
      mimeType: uploaded.type || null,
      kind: kind || null,
      description: description || null,
      data: new Uint8Array(await uploaded.arrayBuffer()),
    });
    return apiData(evidence, { status: 201 });
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}
