import { randomBytes } from "node:crypto";
import type { PublicMaintenanceRequestToken } from "@prisma/client";
import { apiError } from "@/lib/api-response";
import { db } from "@/lib/db";
import {
  PUBLIC_REQUEST_SCOPES,
  getPublicRequestTokenScopes,
  hasPublicRequestScope,
  hashPublicRequestToken,
  type PublicRequestScope,
} from "@/lib/public-requests/tokens";

const API_KEY_PREFIX = "gmao_sk_";
const API_KEY_KIND = "API_KEY";

function isScope(value: unknown): value is PublicRequestScope {
  return typeof value === "string" && (PUBLIC_REQUEST_SCOPES as readonly string[]).includes(value);
}

async function apiKeyCreationAudit(tokenId: string) {
  const audit = await db.auditLog.findFirst({
    where: {
      entityType: "PublicMaintenanceRequestToken",
      entityId: tokenId,
      action: "CREATED",
    },
    select: { afterJson: true },
    orderBy: { createdAt: "asc" },
  });
  if (!audit?.afterJson) return null;

  try {
    const metadata = JSON.parse(audit.afterJson) as {
      credentialKind?: unknown;
      scopes?: unknown;
    };
    if (metadata.credentialKind !== API_KEY_KIND) return null;
    if (!Array.isArray(metadata.scopes) || !metadata.scopes.every(isScope)) return null;
    return { scopes: [...new Set(metadata.scopes)] };
  } catch {
    return null;
  }
}

export async function createApiKey(input: {
  organizationId: string;
  siteId: string;
  name: string;
  scopes: readonly PublicRequestScope[];
  createdById: string;
  expiresAt: Date;
}) {
  const apiKey = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const scopes = [...new Set(input.scopes)];

  const record = await db.$transaction(async (tx) => {
    const created = await tx.publicMaintenanceRequestToken.create({
      data: {
        organizationId: input.organizationId,
        siteId: input.siteId,
        name: input.name,
        tokenHash: hashPublicRequestToken(apiKey),
        mode: "EMBEDDED",
        allowedOrigins: [],
        expiresAt: input.expiresAt,
        createdById: input.createdById,
      },
      select: {
        id: true,
        organizationId: true,
        siteId: true,
        name: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: input.createdById,
        entityType: "PublicMaintenanceRequestToken",
        entityId: created.id,
        action: "CREATED",
        afterJson: JSON.stringify({
          credentialKind: API_KEY_KIND,
          organizationId: created.organizationId,
          siteId: created.siteId,
          name: created.name,
          scopes,
          expiresAt: created.expiresAt,
        }),
      },
    });

    return created;
  });

  return { apiKey, ...record, scopes };
}

export async function isApiKeyRecord(tokenId: string) {
  return Boolean(await apiKeyCreationAudit(tokenId));
}

export async function listApiKeys(input: { organizationId: string; siteId: string }) {
  const audits = await db.auditLog.findMany({
    where: {
      entityType: "PublicMaintenanceRequestToken",
      action: "CREATED",
      afterJson: { contains: `\"credentialKind\":\"${API_KEY_KIND}\"` },
    },
    select: { entityId: true },
  });
  const ids = audits.map((audit) => audit.entityId);
  if (ids.length === 0) return [];

  const records = await db.publicMaintenanceRequestToken.findMany({
    where: {
      id: { in: ids },
      organizationId: input.organizationId,
      siteId: input.siteId,
    },
    select: {
      id: true,
      name: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
      lastUsedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return Promise.all(
    records.map(async (record) => ({
      ...record,
      scopes: await getPublicRequestTokenScopes(record.id, record.createdAt),
    })),
  );
}

export async function resolveApiKey(rawKey: string, now = new Date()) {
  if (!rawKey.startsWith(API_KEY_PREFIX)) return null;
  const record = await db.publicMaintenanceRequestToken.findUnique({
    where: { tokenHash: hashPublicRequestToken(rawKey) },
  });
  if (
    !record ||
    record.revokedAt ||
    (record.expiresAt && record.expiresAt <= now) ||
    record.allowedOrigins.length !== 0
  ) {
    return null;
  }

  const metadata = await apiKeyCreationAudit(record.id);
  if (!metadata) return null;

  return { ...record, scopes: metadata.scopes };
}

export async function authenticateApiKeyRequest(
  request: Request,
  requiredScope: PublicRequestScope,
): Promise<
  | { token: PublicMaintenanceRequestToken & { scopes: PublicRequestScope[] } }
  | { error: Response }
> {
  if (request.headers.get("origin")) {
    return {
      error: apiError(
        403,
        "API_KEY_BROWSER_FORBIDDEN",
        "Server API keys cannot be used by browser-origin requests",
      ),
    };
  }

  const rawKey = request.headers.get("X-API-Key")?.trim();
  if (!rawKey) {
    return { error: apiError(401, "API_KEY_REQUIRED", "X-API-Key header is required") };
  }

  const token = await resolveApiKey(rawKey);
  if (!token) {
    return { error: apiError(401, "INVALID_API_KEY", "API key is invalid, expired or revoked") };
  }
  if (!hasPublicRequestScope(token, requiredScope)) {
    return {
      error: apiError(403, "API_KEY_SCOPE_DENIED", "API key does not allow this operation"),
    };
  }

  await db.publicMaintenanceRequestToken.update({
    where: { id: token.id },
    data: { lastUsedAt: new Date() },
  });

  return { token };
}
