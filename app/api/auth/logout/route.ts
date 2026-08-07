import { apiData, apiError } from "@/lib/api-response";
import { revokeSession } from "@/lib/auth/session";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return apiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    return apiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  await revokeSession(token);
  return apiData({ revoked: true });
}
