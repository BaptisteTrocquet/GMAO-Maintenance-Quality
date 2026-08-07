import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { assertPermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { DocumentControlError, updateDraftDocumentRevision } from "@/lib/documents/control";

const updateSchema = z.object({
  organizationId: z.string().min(1),
  changeSummary: z.string().max(5000).nullable(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ documentId: string; revisionId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid revision update", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertPermission(auth.tenant.scope, "document:manage");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const { documentId, revisionId } = await context.params;
  try {
    const revision = await updateDraftDocumentRevision({
      organizationId: parsed.data.organizationId,
      documentId,
      revisionId,
      actorId: auth.session.user.id,
      changeSummary: parsed.data.changeSummary,
    });
    return apiData(revision);
  } catch (error) {
    if (error instanceof DocumentControlError) {
      if (error.code === "REVISION_NOT_FOUND") return apiError(404, error.code, error.message);
      if (error.code === "REVISION_IMMUTABLE") return apiError(409, error.code, error.message);
    }
    throw error;
  }
}
