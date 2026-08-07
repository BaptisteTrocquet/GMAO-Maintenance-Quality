import { apiData, apiError } from "@/lib/api-response";
import { resolveSession } from "@/lib/auth/session";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return apiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    return apiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const session = await resolveSession(token);
  if (!session) {
    return apiError(401, "INVALID_SESSION", "Session is invalid or expired");
  }

  return apiData({
    id: session.id,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    user: session.user,
  });
}
