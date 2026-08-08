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

const phaseSchema = z.enum([
  "EVENT",
  "CONTAINMENT",
  "ROOT_CAUSE",
  "CAPA",
  "EFFECTIVENESS",
  "EIGHT_D",
]);

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  phase: phaseSchema,
  kind: z.enum(["DOCUMENT", "PHOTO", "RECORD"]),
  description: z.string().trim().max(5000).nullable().optional(),
});

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
  if (error.code === "EVENT_CLOSED" || error.code === "FILE_INTEGRITY_FAILED") {
    return apiError(409, error.code, error.message);
  }
  if (error.code === "FILE_TOO_LARGE") {
    return apiError(413, error.code, error.message);
  }
  return apiError(400, error.code, error.message);
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

  const phaseValue = url.searchParams.get("phase");
  const phase = phaseValue ? phaseSchema.safeParse(phaseValue) : null;
  if (phase && !phase.success) {
    return apiError(400, "INVALID_PHASE", "phase must be a supported quality evidence phase");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, siteId, "quality:read");
  } catch (error) {
    return denied(error);
  }

  const evidence = await listQualityEvidence({
    organizationId,
    siteId,
    eventId,
    ...(phase?.success ? { phase: phase.data } : {}),
  });
  if (evidence === null) {
    return apiError(404, "QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  return apiData(evidence);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return apiError(400, "INVALID_FORM_DATA", "Request body must be multipart form data");
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return apiError(400, "FILE_REQUIRED", "A quality evidence file is required");
  }
  if (file.size > MAX_QUALITY_EVIDENCE_BYTES) {
    return apiError(
      413,
      "FILE_TOO_LARGE",
      `Quality evidence file cannot exceed ${MAX_QUALITY_EVIDENCE_BYTES} bytes`,
    );
  }

  const parsed = createSchema.safeParse({
    organizationId: formData.get("organizationId"),
    siteId: formData.get("siteId"),
    phase: formData.get("phase"),
    kind: formData.get("kind"),
    description: formData.get("description") || null,
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid evidence attachment payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  } catch (error) {
    return denied(error);
  }

  try {
    const evidence = await addQualityEvidence({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      eventId,
      phase: parsed.data.phase,
      kind: parsed.data.kind,
      fileName: file.name,
      mimeType: file.type || null,
      description: parsed.data.description ?? null,
      actorId: auth.session.user.id,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    return apiData(evidence, { status: 201 });
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}
