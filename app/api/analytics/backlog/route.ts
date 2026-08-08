import { hasSiteAccess } from "@/lib/access-control";
import { BacklogAnalyticsError, exportBacklogCsv, getBacklogAnalytics } from "@/lib/analytics/backlog";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  const assetId = url.searchParams.get("assetId");
  const fromDate = url.searchParams.get("fromDate");
  const toDate = url.searchParams.get("toDate");
  const format = url.searchParams.get("format") ?? "json";

  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }
  if (format !== "json" && format !== "csv") {
    return apiError(400, "INVALID_FORMAT", "format must be json or csv");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) {
    if (auth.error) return auth.error;
    return apiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  if (!hasSiteAccess(auth.tenant.scope, siteId) || !can(auth.tenant.scope.role, "work:read")) {
    return apiError(403, "ACCESS_DENIED", "Backlog analytics access denied");
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
  if (!site) {
    return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");
  }

  if (assetId) {
    const asset = await db.asset.findFirst({
      where: {
        id: assetId,
        siteId,
        site: { organizationId, active: true },
      },
      select: { id: true },
    });
    if (!asset) {
      return apiError(404, "ASSET_NOT_FOUND", "Asset not found in site scope");
    }
  }

  const input = { organizationId, siteId, assetId, fromDate, toDate };
  try {
    if (format === "csv") {
      const exported = await exportBacklogCsv(input);
      return new Response(exported.csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="backlog-analytics.csv"',
          "x-export-row-count": String(exported.rowCount),
          "x-export-truncated": String(exported.truncated),
          "x-export-limit": String(exported.limit),
        },
      });
    }
    return apiData(await getBacklogAnalytics(input));
  } catch (error) {
    if (error instanceof BacklogAnalyticsError) {
      return apiError(400, error.code, error.message);
    }
    throw error;
  }
}
