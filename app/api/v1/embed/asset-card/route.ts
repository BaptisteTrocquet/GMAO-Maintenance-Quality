import { apiData, apiError } from "@/lib/api-response";
import { verifyEmbedProof } from "@/lib/embed/proof";
import { getPublicAssetCard, PublicAssetCardError } from "@/lib/public-assets/card";
import { hasPublicRequestScope, isOriginAllowed, resolvePublicRequestToken } from "@/lib/public-requests/tokens";

function readBearer(request: Request) {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  const assetCode = url.searchParams.get("assetCode")?.trim();
  if (!tokenId || !assetCode) {
    return apiError(400, "ASSET_SCOPE_REQUIRED", "tokenId and assetCode are required");
  }

  const credential = readBearer(request);
  if (!credential) return apiError(401, "TOKEN_REQUIRED", "Scoped token is required");
  const proof = request.headers.get("X-Embed-Proof")?.trim();
  if (!proof) return apiError(401, "EMBED_PROOF_REQUIRED", "Signed embed proof is required");

  const token = await resolvePublicRequestToken({ tokenId, token: credential });
  if (!token || token.mode !== "EMBEDDED") {
    return apiError(401, "INVALID_TOKEN", "Embedded token is unavailable");
  }
  if (!hasPublicRequestScope(token, "asset:read")) {
    return apiError(403, "TOKEN_SCOPE_DENIED", "Scoped token cannot read asset cards");
  }

  const payload = verifyEmbedProof({ proof, tokenId: token.id, tokenHash: token.tokenHash });
  if (!payload || !isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin: payload.parentOrigin })) {
    return apiError(403, "INVALID_EMBED_PROOF", "Embed proof is invalid or expired");
  }

  try {
    return apiData(await getPublicAssetCard({ token, assetCode, origin: payload.parentOrigin }));
  } catch (error) {
    if (error instanceof PublicAssetCardError) {
      return apiError(error.code === "RATE_LIMITED" ? 429 : 404, error.code, error.message);
    }
    throw error;
  }
}
