import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { IntegrationDeadLetterError } from "@/lib/integrations/dead-letter";
import {
  listWebhookDeadLetters,
  replayWebhookDeadLetter,
  WebhookDeadLetterError,
} from "@/lib/webhooks/dead-letters";

const replaySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  deadLetterId: z.string().min(1),
});

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

async function requireManager(request: Request, organizationId: string, siteId: string) {
  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth;
  try {
    assertSitePermission(auth.tenant.scope, siteId, "site:manage");
  } catch (error) {
    return { error: denied(error) };
  }
  return auth;
}

function deadLetterError(error: unknown) {
  if (error instanceof IntegrationDeadLetterError) {
    if (error.code === "DEAD_LETTER_NOT_FOUND") {
      return apiError(404, error.code, error.message);
    }
    if (error.code === "TENANT_SCOPE_MISMATCH") {
      return apiError(404, "SITE_NOT_FOUND", "Site not found");
    }
    return apiError(400, error.code, error.message);
  }
  if (error instanceof WebhookDeadLetterError) {
    return apiError(
      error.code === "WEBHOOK_SUBSCRIPTION_UNAVAILABLE" ? 409 : 400,
      error.code,
      error.message,
    );
  }
  throw error;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await requireManager(request, organizationId, siteId);
  if ("error" in auth) return auth.error;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit ? Number(rawLimit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 250)) {
    return apiError(400, "INVALID_LIMIT", "limit must be an integer between 1 and 250");
  }

  try {
    return apiData(await listWebhookDeadLetters({ organizationId, siteId, limit }));
  } catch (error) {
    return deadLetterError(error);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = replaySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid dead-letter replay payload", parsed.error.flatten());
  }

  const auth = await requireManager(
    request,
    parsed.data.organizationId,
    parsed.data.siteId,
  );
  if ("error" in auth) return auth.error;

  try {
    const result = await replayWebhookDeadLetter({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      deadLetterId: parsed.data.deadLetterId,
      actorId: auth.session.user.id,
    });
    return apiData(result);
  } catch (error) {
    return deadLetterError(error);
  }
}
