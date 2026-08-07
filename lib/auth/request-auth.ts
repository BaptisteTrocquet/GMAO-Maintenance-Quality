import { apiError } from "@/lib/api-response";
import { resolveSession } from "@/lib/auth/session";
import { loadTenantContext } from "@/lib/tenant-context";

export async function authenticateRequest(request: Request, organizationId: string) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return { error: apiError(401, "UNAUTHENTICATED", "Authentication required") } as const;
  }

  const token = authorization.slice("Bearer ".length).trim();
  const session = await resolveSession(token);
  if (!session) {
    return { error: apiError(401, "INVALID_SESSION", "Session is invalid or expired") } as const;
  }

  const tenant = await loadTenantContext(session.user.id, organizationId);
  if (!tenant) {
    return { error: apiError(403, "TENANT_ACCESS_DENIED", "Organization access denied") } as const;
  }

  return { session, tenant } as const;
}
