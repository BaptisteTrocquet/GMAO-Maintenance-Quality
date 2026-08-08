import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  deleteSavedMaintenanceView,
  SavedMaintenanceViewError,
} from "@/lib/maintenance/saved-views";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

function savedViewError(error: unknown) {
  if (error instanceof SavedMaintenanceViewError) {
    return apiError(
      error.code === "VIEW_NOT_FOUND" ? 404 : 400,
      error.code,
      error.message,
    );
  }
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
}

async function authorize(request: Request, organizationId: string, siteId: string) {
  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, siteId, "work:read");
  } catch (error) {
    return savedViewError(error);
  }
  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
  if (!site) {
    return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");
  }
  return auth;
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ viewId: string }> },
) {
  const url = new URL(request.url);
  const parsed = scopeSchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_QUERY", "organizationId and siteId are required");
  }

  const auth = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if (auth instanceof Response) return auth;
  const { viewId } = await context.params;

  try {
    return apiData(
      await deleteSavedMaintenanceView({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        userId: auth.session.user.id,
        viewId,
      }),
    );
  } catch (error) {
    return savedViewError(error);
  }
}
