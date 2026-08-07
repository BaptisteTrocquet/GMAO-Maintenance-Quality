import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { getMaintenanceForecast } from "@/lib/maintenance/forecast";

const querySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  horizonDays: z.coerce.number().int().min(1).max(180).default(30),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
    horizonDays: url.searchParams.get("horizonDays") ?? 30,
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_FORECAST_QUERY", "Invalid maintenance forecast query", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "maintenance:read");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const forecast = await getMaintenanceForecast(parsed.data);
  if (!forecast) return apiError(404, "SITE_NOT_FOUND", "Site not found");

  return apiData(forecast);
}
