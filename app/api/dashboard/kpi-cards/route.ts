import { z } from "zod";
import { hasSiteAccess } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  DASHBOARD_KPI_KEYS,
  DashboardKpiConfigError,
  getDashboardKpiConfig,
  saveDashboardKpiConfig,
} from "@/lib/dashboard/kpi-cards";
import { db } from "@/lib/db";

const querySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});
const bodySchema = querySchema.extend({
  cards: z.array(z.enum(DASHBOARD_KPI_KEYS)).max(DASHBOARD_KPI_KEYS.length),
});

async function authorize(request: Request, organizationId: string, siteId: string) {
  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return { error: auth.error ?? apiError(401, "UNAUTHENTICATED", "Authentication required") };
  if (!hasSiteAccess(auth.tenant.scope, siteId)) {
    return { error: apiError(403, "ACCESS_DENIED", "Site access denied") };
  }
  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
  if (!site) return { error: apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope") };
  return { auth };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) return apiError(400, "INVALID_QUERY", "organizationId and siteId are required");

  const access = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if ("error" in access) return access.error;
  return apiData(
    await getDashboardKpiConfig({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      userId: access.auth.session.user.id,
    }),
  );
}

export async function PATCH(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiError(400, "INVALID_BODY", "Valid organizationId, siteId and KPI cards are required", parsed.error.flatten());

  const access = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if ("error" in access) return access.error;
  try {
    return apiData(
      await saveDashboardKpiConfig({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        userId: access.auth.session.user.id,
        cards: parsed.data.cards,
      }),
    );
  } catch (error) {
    if (error instanceof DashboardKpiConfigError) {
      return apiError(400, error.code, error.message);
    }
    throw error;
  }
}
