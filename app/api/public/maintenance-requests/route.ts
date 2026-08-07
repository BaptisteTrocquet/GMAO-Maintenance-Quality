import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { db } from "@/lib/db";
import {
  createPublicMaintenanceRequest,
  PublicMaintenanceRequestError,
} from "@/lib/public-requests/create-request";
import {
  getPublicRequestTokenScopes,
  hasPublicRequestScope,
  isOriginAllowed,
  resolvePublicRequestToken,
} from "@/lib/public-requests/tokens";

const requestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  assetCode: z.string().trim().min(1).max(50).nullable().optional(),
  requesterName: z.string().trim().min(1).max(150).nullable().optional(),
  requesterEmail: z.string().email().max(320).nullable().optional(),
  requesterRef: z.string().trim().min(1).max(150).nullable().optional(),
});

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function withCors<T extends Response>(response: T, origin: string | null) {
  if (!origin) return response;
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    response.headers.set(key, value);
  }
  return response;
}

async function activeTokenForPreflight(tokenId: string) {
  const token = await db.publicMaintenanceRequestToken.findUnique({ where: { id: tokenId } });
  if (!token || token.revokedAt || (token.expiresAt && token.expiresAt <= new Date())) return null;
  const scopes = await getPublicRequestTokenScopes(token.id);
  if (!hasPublicRequestScope({ scopes }, "maintenance:request:create")) return null;
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

export async function POST(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  if (!tokenId) return apiError(400, "TOKEN_ID_REQUIRED", "tokenId query parameter is required");

  const rawToken = bearerToken(request);
  if (!rawToken) return apiError(401, "TOKEN_REQUIRED", "Bearer public request token is required");

  const token = await resolvePublicRequestToken({ tokenId, token: rawToken });
  if (!token) return apiError(401, "INVALID_TOKEN", "Public request token is invalid, expired or revoked");

  const origin = request.headers.get("origin");
  if (!isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin })) {
    return apiError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed for this token");
  }
  if (!hasPublicRequestScope(token, "maintenance:request:create")) {
    return withCors(
      apiError(403, "TOKEN_SCOPE_DENIED", "Scoped token cannot create maintenance requests"),
      origin,
    );
  }

  const site = await db.site.findFirst({
    where: {
      id: token.siteId,
      organizationId: token.organizationId,
      active: true,
      organization: { active: true },
    },
    select: { id: true },
  });
  if (!site) return withCors(apiError(404, "SITE_NOT_FOUND", "Public request site is unavailable"), origin);

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return withCors(
      apiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A unique Idempotency-Key header between 8 and 200 characters is required",
      ),
      origin,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withCors(apiError(400, "INVALID_JSON", "Request body must be valid JSON"), origin);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return withCors(
      apiError(400, "INVALID_PAYLOAD", "Invalid public maintenance request", parsed.error.flatten()),
      origin,
    );
  }

  try {
    const result = await createPublicMaintenanceRequest({
      token,
      idempotencyKey,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      assetCode: parsed.data.assetCode ?? null,
      requesterName: parsed.data.requesterName ?? null,
      requesterEmail: parsed.data.requesterEmail ?? null,
      requesterRef: parsed.data.requesterRef ?? null,
      origin,
    });

    return withCors(
      apiData(result, { status: result.idempotent ? 200 : 201 }),
      origin,
    );
  } catch (error) {
    if (error instanceof PublicMaintenanceRequestError) {
      const status =
        error.code === "ASSET_NOT_FOUND"
          ? 404
          : error.code === "RATE_LIMITED"
            ? 429
            : 409;
      return withCors(apiError(status, error.code, error.message), origin);
    }
    throw error;
  }
}
