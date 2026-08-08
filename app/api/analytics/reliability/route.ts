import { hasSiteAccess } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { buildReliabilityDashboard } from "@/lib/analytics/reliability";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) {
    return auth.error ?? apiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  if (
    !hasSiteAccess(auth.tenant.scope, siteId) ||
    !can(auth.tenant.scope.role, "maintenance:read")
  ) {
    return apiError(403, "ACCESS_DENIED", "Reliability analytics access denied");
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
  if (!site) {
    return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");
  }

  return apiData(await buildReliabilityDashboard({ organizationId, siteId }));
}
