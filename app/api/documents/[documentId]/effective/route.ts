import { AccessDeniedError, assertPermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { DocumentWorkflowError, resolveEffectiveRevision } from "@/lib/documents/workflow";

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  if (!organizationId) return apiError(400, "INVALID_SCOPE", "organizationId is required");

  const rawAsOf = url.searchParams.get("asOf");
  const asOf = rawAsOf ? new Date(rawAsOf) : new Date();
  if (Number.isNaN(asOf.getTime())) return apiError(400, "INVALID_AS_OF", "asOf must be a valid date");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertPermission(auth.tenant.scope, "document:read");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const { documentId } = await context.params;
  try {
    const revision = await resolveEffectiveRevision({ organizationId, documentId, asOf });
    if (!revision) return apiError(404, "EFFECTIVE_REVISION_NOT_FOUND", "No effective revision exists for the requested date");
    return apiData(revision);
  } catch (error) {
    if (error instanceof DocumentWorkflowError && error.code === "DOCUMENT_NOT_FOUND") {
      return apiError(404, error.code, error.message);
    }
    throw error;
  }
}
