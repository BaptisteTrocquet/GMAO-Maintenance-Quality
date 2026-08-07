import { z } from "zod";
import { AccessDeniedError, assertPermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { decideRevisionApproval, DocumentWorkflowError } from "@/lib/documents/workflow";

const schema = z.object({
  organizationId: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED"]),
  comment: z.string().max(5000).nullable().optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string; revisionId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid approval decision", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertPermission(auth.tenant.scope, "document:approve");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const { documentId, revisionId } = await context.params;
  try {
    return apiData(
      await decideRevisionApproval({
        organizationId: parsed.data.organizationId,
        documentId,
        revisionId,
        actorId: auth.session.user.id,
        decision: parsed.data.decision,
        comment: parsed.data.comment,
      }),
    );
  } catch (error) {
    if (error instanceof DocumentWorkflowError) {
      if (error.code === "REVISION_NOT_FOUND") return apiError(404, error.code, error.message);
      if (error.code === "APPROVER_NOT_ASSIGNED") return apiError(403, error.code, error.message);
      return apiError(409, error.code, error.message);
    }
    throw error;
  }
}
