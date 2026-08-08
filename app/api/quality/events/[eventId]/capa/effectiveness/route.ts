import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  CapaEffectivenessError,
  getCapaEffectiveness,
  listCapaEffectivenessTimeline,
  startCapaEffectivenessReview,
  verifyCapaEffectiveness,
} from "@/lib/quality/effectiveness";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const startSchema = scopeSchema.extend({
  action: z.literal("START"),
  criteria: z.string().trim().min(1).max(5000),
  verifierId: z.string().min(1),
  dueAt: z.string().datetime(),
});

const verifySchema = scopeSchema.extend({
  action: z.literal("VERIFY"),
  result: z.enum(["EFFECTIVE", "INEFFECTIVE"]),
  summary: z.string().trim().min(1).max(5000),
});

const patchSchema = z.discriminatedUnion("action", [startSchema, verifySchema]);

function authorize(
  scope: Parameters<typeof assertSitePermission>[0],
  siteId: string,
  permission: "quality:read" | "quality:manage",
) {
  try {
    assertSitePermission(scope, siteId, permission);
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

function workflowError(error: CapaEffectivenessError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" ||
    error.code === "VERIFIER_NOT_FOUND" ||
    error.code === "EFFECTIVENESS_NOT_FOUND"
      ? 404
      : 409;
  return apiError(status, error.code, error.message);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, siteId, "quality:read");
  if (denied) return denied;

  const effectiveness = await getCapaEffectiveness({ organizationId, siteId, eventId });
  if (effectiveness === null) {
    return apiError(404, "QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  const timeline = await listCapaEffectivenessTimeline({ organizationId, siteId, eventId });
  return apiData({ effectiveness, timeline: timeline ?? [] });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid effectiveness payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    if (parsed.data.action === "START") {
      return apiData(
        await startCapaEffectivenessReview({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          criteria: parsed.data.criteria,
          verifierId: parsed.data.verifierId,
          dueAt: new Date(parsed.data.dueAt),
          actorId: auth.session.user.id,
        }),
      );
    }
    return apiData(
      await verifyCapaEffectiveness({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        result: parsed.data.result,
        summary: parsed.data.summary,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof CapaEffectivenessError) return workflowError(error);
    throw error;
  }
}
