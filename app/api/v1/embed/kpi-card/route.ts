import { apiData, apiError } from "@/lib/api-response";
import { verifyEmbedProof } from "@/lib/embed/proof";
import { getPublicKpiCard, PublicKpiCardError } from "@/lib/public-kpis/card";
import { hasPublicRequestScope, isOriginAllowed, resolvePublicRequestToken } from "@/lib/public-requests/tokens";

function readBearer(request: Request) {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  if (!tokenId) return apiError(400, "TOKEN_ID_REQUIRED", "tokenId is required");

  const credential = readBearer(request);
  if (!credential) return apiError(401, "TOKEN_REQUIRED", "Scoped token is required");
  const proof = request.headers.get("X-Embed-Proof")?.trim();
  if (!proof) return apiError(401, "EMBED_PROOF_REQUIRED", "Signed embed proof is required");

  const token = await resolvePublicRequestToken({ tokenId, token: credential });
  if (!token || token.mode !== "EMBEDDED") return apiError(401, "INVALID_TOKEN", "Embedded token is unavailable");
  if (!hasPublicRequestScope(token, "kpi:read")) return apiError(403, "TOKEN_SCOPE_DENIED", "Scoped token cannot read KPI cards");

  const payload = verifyEmbedProof({ proof, tokenId: token.id, tokenHash: token.tokenHash });
  if (!payload || !isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin: payload.parentOrigin })) {
    return apiError(403, "INVALID_EMBED_PROOF", "Embed proof is invalid or expired");
  }

  try {
    return apiData(await getPublicKpiCard({ token, origin: payload.parentOrigin }));
  } catch (error) {
    if (error instanceof PublicKpiCardError) return apiError(429, error.code, error.message);
    throw error;
  }
}
