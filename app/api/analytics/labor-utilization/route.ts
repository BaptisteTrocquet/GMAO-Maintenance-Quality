import { z } from "zod";
import { hasSiteAccess } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { AnalyticsDateRangeError } from "@/lib/analytics/date-range";
import { buildLaborUtilization, LaborUtilizationError } from "@/lib/analytics/labor-utilization";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  from: dateSchema,
  to: dateSchema,
  assetId: z.string().min(1).optional(),
});

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    assetId: url.searchParams.get("assetId") || undefined,
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_QUERY", "organizationId, siteId, from and to are required; dates must use YYYY-MM-DD", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) {
    return auth.error ?? apiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  if (!hasSiteAccess(auth.tenant.scope, parsed.data.siteId)) {
    return apiError(403, "ACCESS_DENIED", "Site access denied");
  }
  if (!can(auth.tenant.scope.role, "maintenance:read")) {
    return apiError(403, "ACCESS_DENIED", "Maintenance analytics permission required");
  }

  const site = await db.site.findFirst({
    where: { id: parsed.data.siteId, organizationId: parsed.data.organizationId, active: true },
    select: { organization: { select: { timezone: true } } },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");

  try {
    return apiData(await buildLaborUtilization({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      timeZone: site.organization.timezone,
      from: parsed.data.from,
      to: parsed.data.to,
      assetId: parsed.data.assetId,
    }));
  } catch (error) {
    if (error instanceof AnalyticsDateRangeError) return apiError(400, error.code, error.message);
    if (error instanceof LaborUtilizationError) {
      return apiError(error.code === "ASSET_NOT_FOUND" ? 404 : 400, error.code, error.message);
    }
    throw error;
  }
}
