import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { listScopedWebhookSubscriptions } from "@/lib/webhooks/registry";
import {
  WebhookConfigurationError,
  WebhookTargetError,
  deriveWebhookSigningSecret,
} from "@/lib/webhooks/security";
import {
  WEBHOOK_EVENT_TYPES,
  createWebhookSubscription,
  revokeWebhookSubscription,
} from "@/lib/webhooks/subscriptions";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  name: z.string().trim().min(1).max(150),
  url: z.string().url().max(2048),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length),
});

const revokeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  subscriptionId: z.string().uuid(),
});

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
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

  const subscriptions = await listScopedWebhookSubscriptions({
    organizationId,
    siteId,
    includeRevoked: true,
  });
  return apiData(subscriptions);
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid webhook subscription payload", parsed.error.flatten());
  }

  const auth = await requireSiteManager(request, parsed.data.organizationId, parsed.data.siteId);
  if ("error" in auth) return auth.error;

  const active = await listScopedWebhookSubscriptions({
    organizationId: parsed.data.organizationId,
    siteId: parsed.data.siteId,
  });
  if (active.length >= 20) {
    return apiError(409, "WEBHOOK_SUBSCRIPTION_LIMIT", "A site can have at most 20 active webhooks");
  }

  try {
    deriveWebhookSigningSecret("configuration-check");
    const created = await createWebhookSubscription({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      name: parsed.data.name,
      url: parsed.data.url,
      eventTypes: parsed.data.eventTypes,
      createdById: auth.session.user.id,
    });
    return apiData(created, { status: 201 });
  } catch (error) {
    if (error instanceof WebhookConfigurationError) {
      return apiError(503, "WEBHOOKS_NOT_CONFIGURED", error.message);
    }
    if (error instanceof WebhookTargetError) {
      return apiError(400, "INVALID_WEBHOOK_TARGET", error.message);
    }
    if (error instanceof Error && error.message === "WEBHOOK_SUBSCRIPTION_LIMIT") {
      return apiError(409, "WEBHOOK_SUBSCRIPTION_LIMIT", "A site can have at most 20 active webhooks");
    }
    throw error;
  }
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid webhook revocation payload", parsed.error.flatten());
  }

  const auth = await requireSiteManager(request, parsed.data.organizationId, parsed.data.siteId);
  if ("error" in auth) return auth.error;

  const revoked = await revokeWebhookSubscription({
    subscriptionId: parsed.data.subscriptionId,
    organizationId: parsed.data.organizationId,
    siteId: parsed.data.siteId,
    actorId: auth.session.user.id,
  });
  if (!revoked) return apiError(404, "WEBHOOK_NOT_FOUND", "Active webhook subscription not found");
  return apiData({ revoked: true });
}
