import { hasSiteAccess } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  normalizeGlobalSearchQuery,
  searchGlobal,
} from "@/lib/search/global-search";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  const query = normalizeGlobalSearchQuery(url.searchParams.get("q"));

  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }
  if (!query) {
    return apiError(400, "INVALID_QUERY", "Search query must contain at least two characters");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;

  if (!hasSiteAccess(auth.tenant.scope, siteId)) {
    return apiError(403, "ACCESS_DENIED", "Site access denied");
  }

  const results = await searchGlobal({
    organizationId,
    siteId,
    role: auth.tenant.scope.role,
    query,
  });
  return apiData({ query, results });
}
