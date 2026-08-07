import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PublicRequestMode } from "@prisma/client";
import { db } from "@/lib/db";

const DEFAULT_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SCOPE_METADATA_REQUIRED_AFTER = new Date("2026-08-07T20:15:00.000Z");

export const PUBLIC_REQUEST_SCOPES = [
  "maintenance:request:create",
  "maintenance:request:status",
  "asset:read",
  "document:read",
  "kpi:read",
] as const;

export type PublicRequestScope = (typeof PUBLIC_REQUEST_SCOPES)[number];

export const DEFAULT_PUBLIC_REQUEST_SCOPES: readonly PublicRequestScope[] = [
  "maintenance:request:create",
  "maintenance:request:status",
];

function isPublicRequestScope(value: unknown): value is PublicRequestScope {
  return typeof value === "string" && (PUBLIC_REQUEST_SCOPES as readonly string[]).includes(value);
}

function uniqueScopes(scopes: readonly PublicRequestScope[]) {
  return [...new Set(scopes)];
}

function parseStoredScopes(afterJson: string | null): PublicRequestScope[] | null {
  if (!afterJson) return null;

  try {
    const parsed = JSON.parse(afterJson) as { scopes?: unknown };
    if (!("scopes" in parsed)) return null;
    if (!Array.isArray(parsed.scopes)) return [];
    if (!parsed.scopes.every(isPublicRequestScope)) return [];
    return uniqueScopes(parsed.scopes);
  } catch {
    return [];
  }
}

async function resolveTokenCreatedAt(tokenId: string, createdAt?: Date | null) {
  if (createdAt) return createdAt;
  const token = await db.publicMaintenanceRequestToken?.findUnique?.({
    where: { id: tokenId },
    select: { createdAt: true },
  });
  return token?.createdAt ?? null;
}

async function legacyScopeFallback(tokenId: string, createdAt?: Date | null) {
  const effectiveCreatedAt = await resolveTokenCreatedAt(tokenId, createdAt);
  if (!effectiveCreatedAt || effectiveCreatedAt >= SCOPE_METADATA_REQUIRED_AFTER) return [];
  return [...DEFAULT_PUBLIC_REQUEST_SCOPES];
}

export async function getPublicRequestTokenScopes(
  tokenId: string,
  createdAt?: Date | null,
): Promise<PublicRequestScope[]> {
  const audit = await db.auditLog?.findFirst?.({
    where: {
      entityType: "PublicMaintenanceRequestToken",
      entityId: tokenId,
      action: "CREATED",
    },
    select: { afterJson: true },
    orderBy: { createdAt: "asc" },
  });

  if (!audit) return legacyScopeFallback(tokenId, createdAt);

  const storedScopes = parseStoredScopes(audit.afterJson);
  if (storedScopes === null) return legacyScopeFallback(tokenId, createdAt);
  return storedScopes;
}

export function hasPublicRequestScope(
  token: { scopes?: readonly string[] | null },
  scope: PublicRequestScope,
) {
  const scopes = token.scopes ?? DEFAULT_PUBLIC_REQUEST_SCOPES;
  return scopes.includes(scope);
}

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
  scopes?: readonly PublicRequestScope[];
}) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_TOKEN_TTL_MS);
  const scopes = uniqueScopes(input.scopes ?? DEFAULT_PUBLIC_REQUEST_SCOPES);
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
  return { token, ...record, scopes };
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

  return {
    ...record,
    scopes: await getPublicRequestTokenScopes(record.id, record.createdAt),
  };
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
