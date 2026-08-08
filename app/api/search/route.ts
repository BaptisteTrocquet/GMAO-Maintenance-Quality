import { z } from "zod";
import { hasSiteAccess } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { GlobalSearchError, searchGlobal } from "@/lib/search/global-search";

const querySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  q: z.string().min(2).max(100),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
    q: url.searchParams.get("q"),
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_QUERY", "organizationId, siteId and a 2-100 character q are required");
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  if (!hasSiteAccess(auth.tenant.scope, parsed.data.siteId)) {
    return apiError(403, "ACCESS_DENIED", "Site access denied");
  }

  const site = await db.site.findFirst({
    where: {
      id: parsed.data.siteId,
      organizationId: parsed.data.organizationId,
      active: true,
    },
    select: { id: true },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");

  try {
    return apiData(
      await searchGlobal({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        role: auth.tenant.scope.role,
        query: parsed.data.q,
      }),
    );
  } catch (error) {
    if (error instanceof GlobalSearchError) {
      return apiError(400, "INVALID_QUERY", error.message);
    }
    throw error;
  }
}
