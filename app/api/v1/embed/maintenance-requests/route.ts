import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { db } from "@/lib/db";
import { verifyEmbedProof } from "@/lib/embed/proof";
import {
  createPublicMaintenanceRequest,
  PublicMaintenanceRequestError,
} from "@/lib/public-requests/create-request";
import {
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

export async function POST(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  if (!tokenId) return apiError(400, "TOKEN_ID_REQUIRED", "tokenId query parameter is required");

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

  const site = await db.site.findFirst({
    where: {
      id: token.siteId,
      organizationId: token.organizationId,
      active: true,
      organization: { active: true },
    },
    select: { id: true },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Embedded request site is unavailable");

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return apiError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A unique Idempotency-Key header between 8 and 200 characters is required",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid embedded maintenance request", parsed.error.flatten());
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
      origin: proofPayload.parentOrigin,
    });
    return apiData(result, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    if (error instanceof PublicMaintenanceRequestError) {
      const status =
        error.code === "ASSET_NOT_FOUND"
          ? 404
          : error.code === "RATE_LIMITED"
            ? 429
            : 409;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
