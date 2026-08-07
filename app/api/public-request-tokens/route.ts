import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import type { Permission } from "@/lib/permissions";
import {
  createPublicRequestToken,
  DEFAULT_PUBLIC_REQUEST_SCOPES,
  getPublicRequestTokenScopes,
  normalizeAllowedOrigin,
  PUBLIC_REQUEST_SCOPES,
  type PublicRequestScope,
} from "@/lib/public-requests/tokens";

const scopeSchema = z.enum(PUBLIC_REQUEST_SCOPES);

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  name: z.string().trim().min(1).max(150),
  mode: z.enum(["PUBLIC", "EMBEDDED"]).default("PUBLIC"),
  allowedOrigins: z.array(z.string().min(1)).max(50).default([]),
  scopes: z
    .array(scopeSchema)
    .min(1)
    .max(PUBLIC_REQUEST_SCOPES.length)
    .default([...DEFAULT_PUBLIC_REQUEST_SCOPES]),
  expiresInDays: z.number().int().min(1).max(365).default(30),
});

const revokeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  tokenId: z.string().min(1),
});

const delegatedPermission: Record<PublicRequestScope, Permission> = {
  "maintenance:request:create": "work:manage",
  "maintenance:request:status": "work:read",
  "asset:read": "asset:read",
  "document:read": "document:read",
  "kpi:read": "work:read",
};

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

async function requireSiteManager(
  request: Request,
  organizationId: string,
  siteId: string,
) {
  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth;

  try {
    assertSitePermission(auth.tenant.scope, siteId, "site:manage");
  } catch (error) {
    return { error: denied(error) };
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true, organization: { active: true } },
    select: { id: true },
  });
  if (!site) return { error: apiError(404, "SITE_NOT_FOUND", "Site not found") };
  return auth;
}

function canDelegateScopes(
  auth: Awaited<ReturnType<typeof requireSiteManager>>,
  siteId: string,
  scopes: readonly PublicRequestScope[],
) {
  if ("error" in auth) return auth.error;

  try {
    for (const scope of scopes) {
      assertSitePermission(auth.tenant.scope, siteId, delegatedPermission[scope]);
    }
  } catch (error) {
    return denied(error);
  }
  return null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await requireSiteManager(request, organizationId, siteId);
  if ("error" in auth) return auth.error;

  const tokens = await db.publicMaintenanceRequestToken.findMany({
    where: { organizationId, siteId },
    select: {
      id: true,
      name: true,
      mode: true,
      allowedOrigins: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
      lastUsedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return apiData(
    await Promise.all(
      tokens.map(async (token) => ({
        ...token,
        scopes: await getPublicRequestTokenScopes(token.id),
      })),
    ),
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid public request token payload", parsed.error.flatten());
  }

  const auth = await requireSiteManager(request, parsed.data.organizationId, parsed.data.siteId);
  if ("error" in auth) return auth.error;

  const scopeDenied = canDelegateScopes(auth, parsed.data.siteId, parsed.data.scopes);
  if (scopeDenied) return scopeDenied;

  let allowedOrigins: string[];
  try {
    allowedOrigins = [...new Set(parsed.data.allowedOrigins.map(normalizeAllowedOrigin))];
  } catch (error) {
    return apiError(
      400,
      "INVALID_ORIGIN",
      error instanceof Error ? error.message : "Invalid allowed origin",
    );
  }

  if (parsed.data.mode === "EMBEDDED" && allowedOrigins.length === 0) {
    return apiError(
      400,
      "ORIGIN_REQUIRED",
      "Embedded request tokens require at least one exact allowed origin",
    );
  }

  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000);
  const created = await createPublicRequestToken({
    organizationId: parsed.data.organizationId,
    siteId: parsed.data.siteId,
    name: parsed.data.name,
    mode: parsed.data.mode,
    allowedOrigins,
    scopes: parsed.data.scopes,
    expiresAt,
    createdById: auth.session.user.id,
  });

  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "PublicMaintenanceRequestToken",
      entityId: created.id,
      action: "CREATED",
      afterJson: JSON.stringify({
        organizationId: created.organizationId,
        siteId: created.siteId,
        name: created.name,
        mode: created.mode,
        allowedOrigins: created.allowedOrigins,
        scopes: created.scopes,
        expiresAt: created.expiresAt,
      }),
    },
  });

  return apiData(created, { status: 201 });
}

export async function DELETE(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid token revocation payload", parsed.error.flatten());
  }

  const auth = await requireSiteManager(request, parsed.data.organizationId, parsed.data.siteId);
  if ("error" in auth) return auth.error;

  const result = await db.publicMaintenanceRequestToken.updateMany({
    where: {
      id: parsed.data.tokenId,
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  if (result.count !== 1) {
    return apiError(404, "TOKEN_NOT_FOUND", "Active public request token not found");
  }

  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "PublicMaintenanceRequestToken",
      entityId: parsed.data.tokenId,
      action: "REVOKED",
    },
  });

  return apiData({ revoked: true });
}
