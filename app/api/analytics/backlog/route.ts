import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { AnalyticsDateRangeError } from "@/lib/analytics/date-range";
import { exportBacklogCsv, getBacklogAnalytics } from "@/lib/analytics/backlog";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";

const querySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  assetId: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

function rangeError(error: AnalyticsDateRangeError) {
  return apiError(400, error.code, error.message);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    organizationId: url.searchParams.get("organizationId") ?? undefined,
    siteId: url.searchParams.get("siteId") ?? undefined,
    assetId: url.searchParams.get("assetId") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    format: url.searchParams.get("format") || "json",
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_QUERY", "Invalid backlog analytics query", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "work:read");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const site = await db.site.findFirst({
    where: {
      id: parsed.data.siteId,
      organizationId: parsed.data.organizationId,
      active: true,
    },
    select: {
      id: true,
      code: true,
      name: true,
      organization: { select: { timezone: true } },
    },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");

  if (parsed.data.assetId) {
    const asset = await db.asset.findFirst({
      where: { id: parsed.data.assetId, siteId: site.id },
      select: { id: true },
    });
    if (!asset) return apiError(404, "ASSET_NOT_FOUND", "Asset not found in site scope");
  }

  const input = {
    organizationId: parsed.data.organizationId,
    siteId: site.id,
    timeZone: site.organization.timezone,
    assetId: parsed.data.assetId ?? null,
    fromDate: parsed.data.from ?? null,
    toDate: parsed.data.to ?? null,
  };

  try {
    if (parsed.data.format === "csv") {
      const exported = await exportBacklogCsv(input);
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

    return apiData({
      site: {
        id: site.id,
        code: site.code,
        name: site.name,
        timeZone: site.organization.timezone,
      },
      analytics: await getBacklogAnalytics(input),
    });
  } catch (error) {
    if (error instanceof AnalyticsDateRangeError) return rangeError(error);
    throw error;
  }
}
