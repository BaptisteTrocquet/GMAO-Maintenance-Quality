import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { completeCycleCount, CycleCountError } from "@/lib/inventory/cycle-counts";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

function cycleError(error: CycleCountError) {
  const status = error.code === "COUNT_NOT_FOUND" ? 404 : 409;
  return apiError(status, error.code, error.message, error.details);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ countId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = scopeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid cycle count completion payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "inventory:manage");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const { countId } = await context.params;
  try {
    return apiData(
      await completeCycleCount({
        ...parsed.data,
        countId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof CycleCountError) return cycleError(error);
    throw error;
  }
}
