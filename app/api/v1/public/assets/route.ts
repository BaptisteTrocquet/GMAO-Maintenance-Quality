import { apiData, apiError } from "@/lib/api-response";
import { db } from "@/lib/db";
import { getPublicAssetCard, PublicAssetCardError } from "@/lib/public-assets/card";
import {
  getPublicRequestTokenScopes,
  hasPublicRequestScope,
  isOriginAllowed,
  resolvePublicRequestToken,
} from "@/lib/public-requests/tokens";

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function withCors<T extends Response>(response: T, origin: string | null) {
  if (!origin) return response;
  for (const [key, value] of Object.entries(corsHeaders(origin))) response.headers.set(key, value);
  return response;
}

async function activeTokenForPreflight(tokenId: string) {
  const token = await db.publicMaintenanceRequestToken.findUnique({ where: { id: tokenId } });
  if (!token || token.revokedAt || (token.expiresAt && token.expiresAt <= new Date())) return null;
  const scopes = await getPublicRequestTokenScopes(token.id, token.createdAt);
  if (!hasPublicRequestScope({ scopes }, "asset:read")) return null;
  return token;
}

export async function OPTIONS(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  const origin = request.headers.get("origin");
  if (!tokenId || !origin) return new Response(null, { status: 400 });

  const token = await activeTokenForPreflight(tokenId);
  if (!token || !isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin })) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  const assetCode = url.searchParams.get("assetCode")?.trim();
  if (!tokenId || !assetCode) {
    return apiError(400, "ASSET_SCOPE_REQUIRED", "tokenId and assetCode query parameters are required");
  }

  const rawToken = bearerToken(request);
  if (!rawToken) return apiError(401, "TOKEN_REQUIRED", "Bearer scoped token is required");
  const token = await resolvePublicRequestToken({ tokenId, token: rawToken });
  if (!token) return apiError(401, "INVALID_TOKEN", "Scoped token is invalid, expired or revoked");

  const origin = request.headers.get("origin");
  if (!isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin })) {
    return apiError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed for this token");
  }
  if (!hasPublicRequestScope(token, "asset:read")) {
    return withCors(apiError(403, "TOKEN_SCOPE_DENIED", "Scoped token cannot read asset cards"), origin);
  }

  try {
    return withCors(
      apiData(await getPublicAssetCard({ token, assetCode, origin })),
      origin,
    );
  } catch (error) {
    if (error instanceof PublicAssetCardError) {
      const status = error.code === "RATE_LIMITED" ? 429 : 404;
      return withCors(apiError(status, error.code, error.message), origin);
    }
    throw error;
  }
}
