import { z } from "zod";
import { AccessDeniedError, assertPermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { reconcileEffectiveRevisions } from "@/lib/documents/workflow";

const schema = z.object({
  organizationId: z.string().min(1),
  asOf: z.coerce.date().optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid effective scheduler request", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertPermission(auth.tenant.scope, "document:approve");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  return apiData(
    await reconcileEffectiveRevisions({
      organizationId: parsed.data.organizationId,
      asOf: parsed.data.asOf,
      actorId: auth.session.user.id,
    }),
  );
}
