import { z } from "zod";
import { hasSiteAccess } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import {
  AnalyticsDateRangeError,
  resolveAnalyticsDateRange,
} from "@/lib/analytics/date-range";
import { buildMttr, MttrError } from "@/lib/analytics/mttr";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  from: calendarDateSchema,
  to: calendarDateSchema,
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
    return apiError(
      400,
      "INVALID_QUERY",
      "organizationId, siteId, from and to are required; dates must use YYYY-MM-DD",
      parsed.error.flatten(),
    );
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
    where: {
      id: parsed.data.siteId,
      organizationId: parsed.data.organizationId,
      active: true,
    },
    select: { organization: { select: { timezone: true } } },
  });
  if (!site) {
    return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");
  }

  try {
    const range = resolveAnalyticsDateRange({
      from: parsed.data.from,
      to: parsed.data.to,
      timeZone: site.organization.timezone,
    });
    if (!range.from || !range.toExclusive) {
      return apiError(400, "INVALID_DATE_RANGE", "from and to are required");
    }

    return apiData(
      await buildMttr({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        from: range.from,
        to: range.toExclusive,
        assetId: parsed.data.assetId,
      }),
    );
  } catch (error) {
    if (error instanceof AnalyticsDateRangeError) {
      return apiError(400, error.code, error.message);
    }
    if (error instanceof MttrError) {
      return apiError(error.code === "INVALID_DATE_RANGE" ? 400 : 404, error.code, error.message);
    }
    throw error;
  }
}
