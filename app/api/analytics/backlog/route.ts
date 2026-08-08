import { hasSiteAccess } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import {
  AnalyticsDateRangeError,
  resolveAnalyticsDateRange,
} from "@/lib/analytics/date-range";
import { buildBacklogDashboard, exportBacklogCsv } from "@/lib/analytics/backlog";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  const format = url.searchParams.get("format") ?? "json";
  const assetId = url.searchParams.get("assetId") || undefined;
  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || undefined;

  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }
  if (format !== "json" && format !== "csv") {
    return apiError(400, "INVALID_FORMAT", "format must be json or csv");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) {
    return auth.error ?? apiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  if (!hasSiteAccess(auth.tenant.scope, siteId) || !can(auth.tenant.scope.role, "work:read")) {
    return apiError(403, "ACCESS_DENIED", "Backlog analytics access denied");
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true, code: true, organization: { select: { timezone: true } } },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");

  try {
    if (from || to) {
      resolveAnalyticsDateRange({
        from,
        to,
        timeZone: site.organization.timezone,
      });
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
        return apiError(404, "ASSET_NOT_FOUND", "Asset not found in the selected site scope");
      }
    }

    const optionalFilters = {
      ...(assetId ? { assetId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    };

    if (format === "csv") {
      const exported = await exportBacklogCsv({
        organizationId,
        siteId,
        ...optionalFilters,
        ...(from || to ? { timeZone: site.organization.timezone } : {}),
      });
      const fileName = `backlog-${site.code}-${new Date().toISOString().slice(0, 10)}.csv`;
      return new Response(exported.csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${fileName.replaceAll('"', "")}"`,
          "x-opengmao-row-count": String(exported.rowCount),
          "x-opengmao-export-limit": String(exported.limit),
          "x-opengmao-truncated": String(exported.truncated),
        },
      });
    }

    return apiData(
      await buildBacklogDashboard({
        organizationId,
        siteId,
        timeZone: site.organization.timezone,
        ...optionalFilters,
      }),
    );
  } catch (error) {
    if (error instanceof AnalyticsDateRangeError) {
      return apiError(400, error.code, error.message);
    }
    throw error;
  }
}
