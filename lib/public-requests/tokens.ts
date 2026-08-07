import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PublicRequestMode } from "@prisma/client";
import { db } from "@/lib/db";

const DEFAULT_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export function hashPublicRequestToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeAllowedOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https origins are allowed");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Allowed origins must not include credentials, paths, query strings or fragments");
  }
  return url.origin;
}

export async function createPublicRequestToken(input: {
  organizationId: string;
  siteId: string;
  name: string;
  mode: PublicRequestMode;
  allowedOrigins: string[];
  createdById: string;
  expiresAt?: Date;
}) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_TOKEN_TTL_MS);
  const record = await db.publicMaintenanceRequestToken.create({
    data: {
      organizationId: input.organizationId,
      siteId: input.siteId,
      name: input.name,
      mode: input.mode,
      allowedOrigins: [...new Set(input.allowedOrigins.map(normalizeAllowedOrigin))],
      tokenHash: hashPublicRequestToken(token),
      expiresAt,
      createdById: input.createdById,
    },
    select: {
      id: true,
      organizationId: true,
      siteId: true,
      name: true,
      mode: true,
      allowedOrigins: true,
      expiresAt: true,
      createdAt: true,
    },
  });
  return { token, ...record };
}

export async function resolvePublicRequestToken(input: {
  tokenId: string;
  token: string;
  now?: Date;
}) {
  const record = await db.publicMaintenanceRequestToken.findUnique({
    where: { id: input.tokenId },
  });
  if (!record || record.revokedAt || (record.expiresAt && record.expiresAt <= (input.now ?? new Date()))) {
    return null;
  }

  const expected = Buffer.from(record.tokenHash, "hex");
  const supplied = Buffer.from(hashPublicRequestToken(input.token), "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  return record;
}

export function isOriginAllowed(input: {
  mode: PublicRequestMode;
  allowedOrigins: readonly string[];
  origin: string | null;
}) {
  if (input.mode === "EMBEDDED" && !input.origin) return false;
  if (!input.origin) return input.mode === "PUBLIC";

  let normalized: string;
  try {
    normalized = normalizeAllowedOrigin(input.origin);
  } catch {
    return false;
  }

  if (input.mode === "EMBEDDED") return input.allowedOrigins.includes(normalized);
  if (input.allowedOrigins.length === 0) return true;
  return input.allowedOrigins.includes(normalized);
}
