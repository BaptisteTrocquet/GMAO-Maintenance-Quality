import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  deleteSavedWorkOrderView,
  SavedWorkOrderViewError,
} from "@/lib/maintenance/saved-views";

const deleteSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

function authorize(scope: Parameters<typeof assertSitePermission>[0], siteId: string) {
  try {
    assertSitePermission(scope, siteId, "work:read");
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ viewId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid saved-view delete payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId);
  if (denied) return denied;

  const { viewId } = await context.params;
  try {
    return apiData(
      await deleteSavedWorkOrderView({
        userId: auth.session.user.id,
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        viewId,
      }),
    );
  } catch (error) {
    if (error instanceof SavedWorkOrderViewError) {
      return apiError(error.code === "VIEW_NOT_FOUND" ? 404 : 400, error.code, error.message);
    }
    throw error;
  }
}
