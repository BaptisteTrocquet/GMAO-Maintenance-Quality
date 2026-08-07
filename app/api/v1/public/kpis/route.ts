import { apiData, apiError } from "@/lib/api-response";
import { db } from "@/lib/db";
import { getPublicKpiCard, PublicKpiCardError } from "@/lib/public-kpis/card";
import {
  getPublicRequestTokenScopes,
  hasPublicRequestScope,
  isOriginAllowed,
  resolvePublicRequestToken,
} from "@/lib/public-requests/tokens";

function readBearer(request: Request) {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
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
  if (!hasPublicRequestScope({ scopes }, "kpi:read")) return null;
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
  if (!tokenId) return apiError(400, "TOKEN_ID_REQUIRED", "tokenId is required");

  const credential = readBearer(request);
  if (!credential) return apiError(401, "TOKEN_REQUIRED", "Scoped token is required");
  const token = await resolvePublicRequestToken({ tokenId, token: credential });
  if (!token) return apiError(401, "INVALID_TOKEN", "Scoped token is invalid, expired or revoked");

  const origin = request.headers.get("origin");
  if (!isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin })) {
    return apiError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed for this token");
  }
  if (!hasPublicRequestScope(token, "kpi:read")) {
    return withCors(apiError(403, "TOKEN_SCOPE_DENIED", "Scoped token cannot read KPI cards"), origin);
  }

  try {
    return withCors(apiData(await getPublicKpiCard({ token, origin })), origin);
  } catch (error) {
    if (error instanceof PublicKpiCardError) return withCors(apiError(429, error.code, error.message), origin);
    throw error;
  }
}
