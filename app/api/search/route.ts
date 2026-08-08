import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
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

  try {
    // Every membership role has asset:read today. This validates site membership once;
    // searchGlobal then applies category-specific permissions before issuing each query.
    assertSitePermission(auth.tenant.scope, siteId, "asset:read");
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return apiError(403, "ACCESS_DENIED", error.message);
    }
    throw error;
  }

  const results = await searchGlobal({
    organizationId,
    siteId,
    role: auth.tenant.scope.role,
    query,
  });
  return apiData({ query, results });
}
