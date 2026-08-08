import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  activateCapa,
  CapaError,
  getCapaWorkspace,
  listCapaTimeline,
  saveCapaWorkspace,
  submitEffectivenessReview,
  transitionCapaAction,
  verifyCapaEffectiveness,
} from "@/lib/quality/capa";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const actionDefinitionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  type: z.enum(["CORRECTIVE", "PREVENTIVE"]),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(5000).nullable().optional(),
  ownerId: z.string().min(1),
  dueAt: z.string().datetime(),
});

const saveSchema = scopeSchema.extend({
  action: z.literal("SAVE"),
  objective: z.string().trim().min(1).max(5000),
  actions: z.array(actionDefinitionSchema).max(100),
});

const activateSchema = scopeSchema.extend({ action: z.literal("ACTIVATE") });

const transitionActionSchema = scopeSchema.extend({
  action: z.literal("TRANSITION_ACTION"),
  actionId: z.string().trim().min(1).max(100),
  status: z.enum(["IN_PROGRESS", "COMPLETED", "CANCELLED"]),
  evidence: z.string().trim().max(5000).nullable().optional(),
});

const effectivenessSchema = scopeSchema.extend({
  action: z.literal("SUBMIT_EFFECTIVENESS"),
  method: z.string().trim().min(1).max(2000),
  ownerId: z.string().min(1),
  dueAt: z.string().datetime(),
});

const verifySchema = scopeSchema.extend({
  action: z.literal("VERIFY_EFFECTIVENESS"),
  result: z.enum(["EFFECTIVE", "INEFFECTIVE"]),
  evidence: z.string().trim().min(1).max(5000),
});

const patchSchema = z.discriminatedUnion("action", [
  saveSchema,
  activateSchema,
  transitionActionSchema,
  effectivenessSchema,
  verifySchema,
]);

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

function capaError(error: CapaError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" ||
    error.code === "CAPA_NOT_FOUND" ||
    error.code === "ACTION_NOT_FOUND" ||
    error.code === "ACTION_OWNER_NOT_FOUND" ||
    error.code === "EFFECTIVENESS_OWNER_NOT_FOUND"
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

  const workspace = await getCapaWorkspace({ organizationId, siteId, eventId });
  if (!workspace) {
    return apiError(404, "QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  const timeline = await listCapaTimeline({ organizationId, siteId, eventId });
  return apiData({ ...workspace, timeline: timeline ?? [] });
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid CAPA workflow payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    if (parsed.data.action === "SAVE") {
      return apiData(
        await saveCapaWorkspace({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          objective: parsed.data.objective,
          actions: parsed.data.actions.map((action) => ({
            ...action,
            description: action.description ?? null,
            dueAt: new Date(action.dueAt),
          })),
          actorId: auth.session.user.id,
        }),
      );
    }

    if (parsed.data.action === "ACTIVATE") {
      return apiData(
        await activateCapa({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          actorId: auth.session.user.id,
        }),
      );
    }

    if (parsed.data.action === "TRANSITION_ACTION") {
      return apiData(
        await transitionCapaAction({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          actionId: parsed.data.actionId,
          status: parsed.data.status,
          evidence: parsed.data.evidence,
          actorId: auth.session.user.id,
        }),
      );
    }

    if (parsed.data.action === "SUBMIT_EFFECTIVENESS") {
      return apiData(
        await submitEffectivenessReview({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          method: parsed.data.method,
          ownerId: parsed.data.ownerId,
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
        evidence: parsed.data.evidence,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof CapaError) return capaError(error);
    throw error;
  }
}
