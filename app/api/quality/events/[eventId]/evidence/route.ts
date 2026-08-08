import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  addQualityEvidence,
  listQualityEvidence,
  MAX_QUALITY_EVIDENCE_BYTES,
  QualityEvidenceError,
} from "@/lib/quality/evidence";

const phaseSchema = z.enum(["EVENT", "CONTAINMENT", "ROOT_CAUSE", "CAPA", "EFFECTIVENESS", "EIGHT_D"]);
const kindSchema = z.enum(["DOCUMENT", "PHOTO", "RECORD"]);

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
      : error.code === "INVALID_EVIDENCE_DATA" ||
          error.code === "FILE_REQUIRED" ||
          error.code === "FILE_TOO_LARGE"
        ? 400
        : 409;
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
  const phaseParam = url.searchParams.get("phase");
  const phase = phaseParam ? phaseSchema.safeParse(phaseParam) : null;
  if (phase && !phase.success) return apiError(400, "INVALID_PHASE", "Unsupported evidence phase");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, siteId, "quality:read");
  if (denied) return denied;

  const evidence = await listQualityEvidence({
    organizationId,
    siteId,
    eventId,
    phase: phase?.success ? phase.data : undefined,
  });
  if (!evidence) return apiError(404, "QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  return apiData(evidence);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError(400, "INVALID_FORM_DATA", "Request must contain valid multipart form data");
  }

  const organizationId = form.get("organizationId");
  const siteId = form.get("siteId");
  const phase = phaseSchema.safeParse(form.get("phase"));
  const kind = kindSchema.safeParse(form.get("kind"));
  const descriptionValue = form.get("description");
  const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";
  const file = form.get("file");
  if (
    typeof organizationId !== "string" ||
    !organizationId ||
    typeof siteId !== "string" ||
    !siteId ||
    !phase.success ||
    !kind.success ||
    description.length > 5000
  ) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid quality evidence metadata");
  }
  if (!(file instanceof File)) return apiError(400, "FILE_REQUIRED", "Quality evidence file is required");
  if (file.size === 0) return apiError(400, "FILE_REQUIRED", "Quality evidence file cannot be empty");
  if (file.size > MAX_QUALITY_EVIDENCE_BYTES) {
    return apiError(400, "FILE_TOO_LARGE", `Quality evidence file cannot exceed ${MAX_QUALITY_EVIDENCE_BYTES} bytes`);
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, siteId, "quality:manage");
  if (denied) return denied;

  try {
    const evidence = await addQualityEvidence({
      organizationId,
      siteId,
      eventId,
      phase: phase.data,
      kind: kind.data,
      fileName: file.name,
      mimeType: file.type || null,
      description: description || null,
      actorId: auth.session.user.id,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    return apiData(evidence, { status: 201 });
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}
