import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  addQualityEvidence,
  listQualityEvidence,
  MAX_QUALITY_EVIDENCE_BYTES,
  QUALITY_EVIDENCE_MIME_TYPES,
  QualityEvidenceError,
} from "@/lib/quality/evidence";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  category: z.enum(["CONTAINMENT", "ROOT_CAUSE", "CAPA_ACTION", "EFFECTIVENESS", "EIGHT_D", "OTHER"]),
  relatedActionId: z.string().trim().min(1).max(200).nullable().optional(),
  fileName: z.string().trim().min(1).max(255),
  storageKey: z.string().trim().min(1).max(1000),
  mimeType: z.enum(QUALITY_EVIDENCE_MIME_TYPES),
  sizeBytes: z.number().int().min(0).max(MAX_QUALITY_EVIDENCE_BYTES),
  note: z.string().trim().max(5000).nullable().optional(),
});

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
  if (
    error.code === "QUALITY_EVENT_NOT_FOUND" ||
    error.code === "EVIDENCE_NOT_FOUND" ||
    error.code === "CAPA_ACTION_NOT_FOUND"
  ) {
    return apiError(404, error.code, error.message);
  }
  if (error.code === "FILE_TOO_LARGE") return apiError(413, error.code, error.message);
  if (error.code === "UNSUPPORTED_FILE_TYPE") return apiError(415, error.code, error.message);
  if (
    error.code === "INVALID_FILE_METADATA" ||
    error.code === "REVOKE_REASON_REQUIRED" ||
    error.code === "CAPA_ACTION_REQUIRED"
  ) {
    return apiError(400, error.code, error.message);
  }
  return apiError(409, error.code, error.message);
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
  const denied = authorize(auth.tenant.scope, siteId, "quality:read");
  if (denied) return denied;

  try {
    return apiData(
      await listQualityEvidence({
        organizationId,
        siteId,
        eventId,
        includeRevoked: url.searchParams.get("includeRevoked") === "true",
      }),
    );
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid quality evidence payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    return apiData(
      await addQualityEvidence({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        category: parsed.data.category,
        relatedActionId: parsed.data.relatedActionId,
        fileName: parsed.data.fileName,
        storageKey: parsed.data.storageKey,
        mimeType: parsed.data.mimeType,
        sizeBytes: parsed.data.sizeBytes,
        note: parsed.data.note,
        actorId: auth.session.user.id,
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof QualityEvidenceError) return evidenceError(error);
    throw error;
  }
}
