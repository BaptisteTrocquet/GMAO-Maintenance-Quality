import { apiData, apiError } from "@/lib/api-response";
import { verifyEmbedProof } from "@/lib/embed/proof";
import {
  getPublicMaintenanceRequestStatus,
  PublicRequestStatusError,
} from "@/lib/public-requests/status";
import {
  isOriginAllowed,
  resolvePublicRequestToken,
} from "@/lib/public-requests/tokens";

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  const trackingId = url.searchParams.get("trackingId")?.trim();
  if (!tokenId || !trackingId) {
    return apiError(400, "TRACKING_SCOPE_REQUIRED", "tokenId and trackingId query parameters are required");
  }

  const rawToken = bearerToken(request);
  if (!rawToken) return apiError(401, "TOKEN_REQUIRED", "Bearer scoped token is required");
  const proof = request.headers.get("X-Embed-Proof")?.trim();
  if (!proof) return apiError(401, "EMBED_PROOF_REQUIRED", "Signed embed proof is required");

  const token = await resolvePublicRequestToken({ tokenId, token: rawToken });
  if (!token || token.mode !== "EMBEDDED") {
    return apiError(401, "INVALID_TOKEN", "Embedded request token is invalid, expired or revoked");
  }

  const proofPayload = verifyEmbedProof({
    proof,
    tokenId: token.id,
    tokenHash: token.tokenHash,
  });
  if (
    !proofPayload ||
    !isOriginAllowed({
      mode: token.mode,
      allowedOrigins: token.allowedOrigins,
      origin: proofPayload.parentOrigin,
    })
  ) {
    return apiError(403, "INVALID_EMBED_PROOF", "Embed proof is invalid, expired or not allowed");
  }

  try {
    return apiData(
      await getPublicMaintenanceRequestStatus({
        token,
        trackingId,
        origin: proofPayload.parentOrigin,
      }),
    );
  } catch (error) {
    if (error instanceof PublicRequestStatusError) {
      const status = error.code === "RATE_LIMITED" ? 429 : error.code === "TRACKING_NOT_FOUND" ? 404 : 409;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
