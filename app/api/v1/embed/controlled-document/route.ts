import { apiError } from "@/lib/api-response";
import { ControlledCopyError } from "@/lib/documents/controlled-copy";
import { verifyEmbedProof } from "@/lib/embed/proof";
import { controlledDocumentResponse } from "@/lib/public-documents/response";
import { issuePublicControlledDocument, PublicDocumentViewerError } from "@/lib/public-documents/viewer";
import { hasPublicRequestScope, isOriginAllowed, resolvePublicRequestToken } from "@/lib/public-requests/tokens";

function readBearer(request: Request) {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  const documentCode = url.searchParams.get("documentCode")?.trim();
  if (!tokenId || !documentCode) {
    return apiError(400, "DOCUMENT_SCOPE_REQUIRED", "tokenId and documentCode are required");
  }

  const rawAsOf = url.searchParams.get("asOf");
  const asOf = rawAsOf ? new Date(rawAsOf) : new Date();
  if (Number.isNaN(asOf.getTime())) return apiError(400, "INVALID_AS_OF", "asOf must be a valid date");

  const credential = readBearer(request);
  if (!credential) return apiError(401, "TOKEN_REQUIRED", "Scoped token is required");
  const proof = request.headers.get("X-Embed-Proof")?.trim();
  if (!proof) return apiError(401, "EMBED_PROOF_REQUIRED", "Signed embed proof is required");

  const token = await resolvePublicRequestToken({ tokenId, token: credential });
  if (!token || token.mode !== "EMBEDDED") {
    return apiError(401, "INVALID_TOKEN", "Embedded token is unavailable");
  }
  if (!hasPublicRequestScope(token, "document:read")) {
    return apiError(403, "TOKEN_SCOPE_DENIED", "Scoped token cannot read controlled documents");
  }

  const payload = verifyEmbedProof({ proof, tokenId: token.id, tokenHash: token.tokenHash });
  if (!payload || !isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin: payload.parentOrigin })) {
    return apiError(403, "INVALID_EMBED_PROOF", "Embed proof is invalid or expired");
  }

  try {
    return controlledDocumentResponse(
      await issuePublicControlledDocument({
        token,
        documentCode,
        asOf,
        origin: payload.parentOrigin,
      }),
    );
  } catch (error) {
    if (error instanceof PublicDocumentViewerError) {
      return apiError(error.code === "RATE_LIMITED" ? 429 : 404, error.code, error.message);
    }
    if (error instanceof ControlledCopyError) {
      return apiError(
        error.code === "EFFECTIVE_FILE_UNAVAILABLE" ? 409 : 404,
        error.code,
        error.message,
      );
    }
    throw error;
  }
}
