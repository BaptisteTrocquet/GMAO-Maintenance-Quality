import { apiError } from "@/lib/api-response";
import { ControlledCopyError } from "@/lib/documents/controlled-copy";
import { db } from "@/lib/db";
import { issuePublicControlledDocument, PublicDocumentViewerError } from "@/lib/public-documents/viewer";
import { controlledDocumentResponse } from "@/lib/public-documents/response";
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
    "Access-Control-Expose-Headers": "Content-Disposition, X-Controlled-Copy, X-Document-Code, X-Document-Title, X-Document-Revision, X-Document-Effective-At, X-Controlled-Copy-As-Of, X-Content-SHA256",
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
  if (!hasPublicRequestScope({ scopes }, "document:read")) return null;
  return token;
}

function parseAsOf(url: URL) {
  const raw = url.searchParams.get("asOf");
  if (!raw) return { asOf: new Date() };
  const asOf = new Date(raw);
  return Number.isNaN(asOf.getTime()) ? { error: apiError(400, "INVALID_AS_OF", "asOf must be a valid date") } : { asOf };
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
  const documentCode = url.searchParams.get("documentCode")?.trim();
  if (!tokenId || !documentCode) {
    return apiError(400, "DOCUMENT_SCOPE_REQUIRED", "tokenId and documentCode are required");
  }

  const parsedAsOf = parseAsOf(url);
  if ("error" in parsedAsOf) return parsedAsOf.error;

  const credential = readBearer(request);
  if (!credential) return apiError(401, "TOKEN_REQUIRED", "Scoped token is required");
  const token = await resolvePublicRequestToken({ tokenId, token: credential });
  if (!token) return apiError(401, "INVALID_TOKEN", "Scoped token is invalid, expired or revoked");

  const origin = request.headers.get("origin");
  if (!isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin })) {
    return apiError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed for this token");
  }
  if (!hasPublicRequestScope(token, "document:read")) {
    return withCors(apiError(403, "TOKEN_SCOPE_DENIED", "Scoped token cannot read controlled documents"), origin);
  }

  try {
    const copy = await issuePublicControlledDocument({
      token,
      documentCode,
      asOf: parsedAsOf.asOf,
      origin,
    });
    return withCors(controlledDocumentResponse(copy), origin);
  } catch (error) {
    if (error instanceof PublicDocumentViewerError) {
      return withCors(apiError(error.code === "RATE_LIMITED" ? 429 : 404, error.code, error.message), origin);
    }
    if (error instanceof ControlledCopyError) {
      const status = error.code === "EFFECTIVE_REVISION_NOT_FOUND" || error.code === "DOCUMENT_NOT_FOUND" ? 404 : 409;
      return withCors(apiError(status, error.code, error.message), origin);
    }
    throw error;
  }
}
