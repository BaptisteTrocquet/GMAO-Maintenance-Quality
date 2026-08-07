import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { createApiKey, isApiKeyRecord, listApiKeys } from "@/lib/integrations/api-keys";
import {
  PUBLIC_REQUEST_SCOPES,
  type PublicRequestScope,
} from "@/lib/public-requests/tokens";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  name: z.string().trim().min(1).max(150),
  scopes: z.array(z.enum(PUBLIC_REQUEST_SCOPES)).min(1).max(PUBLIC_REQUEST_SCOPES.length),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});

const revokeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  apiKeyId: z.string().min(1),
});

const delegatedPermission: Record<PublicRequestScope, Parameters<typeof assertSitePermission>[2]> = {
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

async function requireSiteManager(request: Request, organizationId: string, siteId: string) {
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await requireSiteManager(request, organizationId, siteId);
  if ("error" in auth) return auth.error;
  return apiData(await listApiKeys({ organizationId, siteId }));
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid API key payload", parsed.error.flatten());
  }

  const auth = await requireSiteManager(request, parsed.data.organizationId, parsed.data.siteId);
  if ("error" in auth) return auth.error;

  try {
    for (const scope of parsed.data.scopes) {
      assertSitePermission(auth.tenant.scope, parsed.data.siteId, delegatedPermission[scope]);
    }
  } catch (error) {
    return denied(error);
  }

  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000);
  const created = await createApiKey({
    organizationId: parsed.data.organizationId,
    siteId: parsed.data.siteId,
    name: parsed.data.name,
    scopes: parsed.data.scopes,
    expiresAt,
    createdById: auth.session.user.id,
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid API key revocation payload", parsed.error.flatten());
  }

  const auth = await requireSiteManager(request, parsed.data.organizationId, parsed.data.siteId);
  if ("error" in auth) return auth.error;
  if (!(await isApiKeyRecord(parsed.data.apiKeyId))) {
    return apiError(404, "API_KEY_NOT_FOUND", "API key not found");
  }

  const result = await db.publicMaintenanceRequestToken.updateMany({
    where: {
      id: parsed.data.apiKeyId,
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  if (result.count !== 1) return apiError(404, "API_KEY_NOT_FOUND", "Active API key not found");

  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "PublicMaintenanceRequestToken",
      entityId: parsed.data.apiKeyId,
      action: "REVOKED",
      afterJson: JSON.stringify({ credentialKind: "API_KEY" }),
    },
  });

  return apiData({ revoked: true });
}
