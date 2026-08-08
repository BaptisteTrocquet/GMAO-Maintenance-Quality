import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  CapaError,
  getCapa,
  listCapaTimeline,
  markCapaReadyForEffectiveness,
  saveCapaDraft,
  transitionCapaAction,
} from "@/lib/quality/capa";
import { approveCapa, CapaApprovalError } from "@/lib/quality/capa-approval";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const draftActionSchema = z.object({
  actionKey: z.string().trim().min(1).max(120),
  type: z.enum(["CORRECTIVE", "PREVENTIVE"]),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(5000).nullable().optional(),
  ownerId: z.string().min(1),
  dueAt: z.string().datetime(),
});

const saveSchema = scopeSchema.extend({
  action: z.literal("SAVE"),
  objective: z.string().trim().min(1).max(5000),
  actions: z.array(draftActionSchema).min(1).max(100),
});
const approveSchema = scopeSchema.extend({
  action: z.literal("APPROVE"),
  approvalNote: z.string().trim().max(5000).nullable().optional(),
});
const activateAliasSchema = scopeSchema.extend({
  action: z.literal("ACTIVATE"),
  approvalNote: z.string().trim().max(5000).nullable().optional(),
});
const transitionSchema = scopeSchema.extend({
  action: z.literal("TRANSITION_ACTION"),
  actionId: z.string().min(1),
  transition: z.enum(["START", "COMPLETE", "CANCEL"]),
  completionNote: z.string().trim().max(5000).nullable().optional(),
});
const readySchema = scopeSchema.extend({ action: z.literal("READY_FOR_EFFECTIVENESS") });
const patchSchema = z.discriminatedUnion("action", [
  saveSchema,
  approveSchema,
  activateAliasSchema,
  transitionSchema,
  readySchema,
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

function capaError(error: CapaError | CapaApprovalError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" ||
    error.code === "CAPA_NOT_FOUND" ||
    (error instanceof CapaError &&
      (error.code === "ACTION_NOT_FOUND" || error.code === "ACTION_OWNER_NOT_FOUND"))
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

  const workspace = await getCapa({ organizationId, siteId, eventId });
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
        await saveCapaDraft({
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
    if (parsed.data.action === "APPROVE" || parsed.data.action === "ACTIVATE") {
      return apiData(
        await approveCapa({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          approverId: auth.session.user.id,
          approvalNote: parsed.data.approvalNote,
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
          transition: parsed.data.transition,
          completionNote: parsed.data.completionNote,
          actorId: auth.session.user.id,
        }),
      );
    }
    return apiData(
      await markCapaReadyForEffectiveness({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof CapaError || error instanceof CapaApprovalError) return capaError(error);
    throw error;
  }
}
