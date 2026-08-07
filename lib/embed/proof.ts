import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeAllowedOrigin } from "@/lib/public-requests/tokens";

const DEFAULT_PROOF_TTL_MS = 10 * 60 * 1000;

export type EmbedProofPayload = {
  v: 1;
  tokenId: string;
  parentOrigin: string;
  exp: number;
};

function signPayload(encodedPayload: string, tokenHash: string) {
  return createHmac("sha256", Buffer.from(tokenHash, "hex"))
    .update(encodedPayload)
    .digest("base64url");
}

function encodePayload(payload: EmbedProofPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encoded: string): EmbedProofPayload | null {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<EmbedProofPayload>;
    if (
      value.v !== 1 ||
      typeof value.tokenId !== "string" ||
      !value.tokenId ||
      typeof value.parentOrigin !== "string" ||
      !value.parentOrigin ||
      typeof value.exp !== "number" ||
      !Number.isFinite(value.exp)
    ) {
      return null;
    }
    return {
      v: 1,
      tokenId: value.tokenId,
      parentOrigin: normalizeAllowedOrigin(value.parentOrigin),
      exp: value.exp,
    };
  } catch {
    return null;
  }
}

export function parentOriginFromReferrer(referrer: string | null) {
  if (!referrer) return null;
  try {
    return normalizeAllowedOrigin(new URL(referrer).origin);
  } catch {
    return null;
  }
}

export function createEmbedProof(input: {
  tokenId: string;
  tokenHash: string;
  parentOrigin: string;
  now?: Date;
  ttlMs?: number;
}) {
  const now = input.now ?? new Date();
  const parentOrigin = normalizeAllowedOrigin(input.parentOrigin);
  const payload: EmbedProofPayload = {
    v: 1,
    tokenId: input.tokenId,
    parentOrigin,
    exp: now.getTime() + (input.ttlMs ?? DEFAULT_PROOF_TTL_MS),
  };
  const encoded = encodePayload(payload);
  return `${encoded}.${signPayload(encoded, input.tokenHash)}`;
}

export function verifyEmbedProof(input: {
  proof: string;
  tokenId: string;
  tokenHash: string;
  now?: Date;
}) {
  const [encoded, suppliedSignature, extra] = input.proof.split(".");
  if (!encoded || !suppliedSignature || extra) return null;

  const expectedSignature = signPayload(encoded, input.tokenHash);
  const expected = Buffer.from(expectedSignature, "utf8");
  const supplied = Buffer.from(suppliedSignature, "utf8");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  const payload = decodePayload(encoded);
  if (!payload || payload.tokenId !== input.tokenId) return null;
  if (payload.exp <= (input.now ?? new Date()).getTime()) return null;
  return payload;
}
