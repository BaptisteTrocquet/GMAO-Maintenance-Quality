import { z } from "zod";
import { AccessDeniedError, assertPermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  acknowledgeEffectiveRevision,
  DocumentAcknowledgementError,
  getEffectiveRevisionAcknowledgement,
  listDocumentReadAcknowledgements,
} from "@/lib/documents/acknowledgements";

const acknowledgeSchema = z.object({
  organizationId: z.string().min(1),
  checksum: z.string().regex(/^[a-fA-F0-9]{64}$/, "checksum must be a SHA-256 hex digest"),
  asOf: z.coerce.date().optional(),
});

function authorize(scope: Parameters<typeof assertPermission>[0], permission: "document:read" | "document:manage") {
  try {
    assertPermission(scope, permission);
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

function workflowError(error: DocumentAcknowledgementError) {
  if (error.code === "DOCUMENT_NOT_FOUND" || error.code === "EFFECTIVE_REVISION_NOT_FOUND") {
    return apiError(404, error.code, error.message);
  }
  if (error.code === "CHECKSUM_MISMATCH" || error.code === "REVISION_CHECKSUM_MISSING") {
    return apiError(409, error.code, error.message);
  }
  return apiError(503, error.code, error.message);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = acknowledgeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid acknowledgement payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, "document:read");
  if (denied) return denied;

  const { documentId } = await context.params;
  try {
    const result = await acknowledgeEffectiveRevision({
      organizationId: parsed.data.organizationId,
      documentId,
      actorId: auth.session.user.id,
      checksum: parsed.data.checksum,
      asOf: parsed.data.asOf,
    });
    return apiData(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof DocumentAcknowledgementError) return workflowError(error);
    throw error;
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  if (!organizationId) return apiError(400, "INVALID_SCOPE", "organizationId is required");

  const rawAsOf = url.searchParams.get("asOf");
  const asOf = rawAsOf ? new Date(rawAsOf) : undefined;
  if (asOf && Number.isNaN(asOf.getTime())) return apiError(400, "INVALID_AS_OF", "asOf must be a valid date");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const { documentId } = await context.params;
  const scope = url.searchParams.get("scope") ?? "self";

  try {
    if (scope === "all") {
      const denied = authorize(auth.tenant.scope, "document:manage");
      if (denied) return denied;
      return apiData(await listDocumentReadAcknowledgements({ organizationId, documentId }));
    }
    if (scope !== "self") return apiError(400, "INVALID_SCOPE_MODE", "scope must be self or all");

    const denied = authorize(auth.tenant.scope, "document:read");
    if (denied) return denied;
    return apiData(
      await getEffectiveRevisionAcknowledgement({
        organizationId,
        documentId,
        actorId: auth.session.user.id,
        asOf,
      }),
    );
  } catch (error) {
    if (error instanceof DocumentAcknowledgementError) return workflowError(error);
    throw error;
  }
}
