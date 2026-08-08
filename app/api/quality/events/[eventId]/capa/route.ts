import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  activateCapa,
  getCapaWorkspace,
  listCapaTimeline,
  QualityCapaError,
  reopenIneffectiveCapa,
  saveCapaPlan,
  setCapaActionStatus,
  startCapaVerification,
  verifyCapaEffectiveness,
} from "@/lib/quality/capa";

const actionSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  type: z.enum(["CORRECTIVE", "PREVENTIVE"]),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(5000).nullable().optional(),
  ownerId: z.string().min(1),
  dueAt: z.string().datetime(),
});

const saveSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  actions: z.array(actionSchema).max(100),
  verificationPlan: z.object({
    method: z.string().trim().max(5000),
    acceptanceCriteria: z.string().trim().max(5000),
  }),
});

const activateSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("ACTIVATE"),
});

const setActionStatusSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("SET_ACTION_STATUS"),
  actionId: z.string().min(1),
  status: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED"]),
  completionNote: z.string().trim().max(5000).nullable().optional(),
});

const startVerificationSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("START_VERIFICATION"),
});

const verifyEffectivenessSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("VERIFY_EFFECTIVENESS"),
  effective: z.boolean(),
  result: z.string().trim().min(1).max(5000),
});

const reopenSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("REOPEN"),
});

const transitionSchema = z.discriminatedUnion("action", [
  activateSchema,
  setActionStatusSchema,
  startVerificationSchema,
  verifyEffectivenessSchema,
  reopenSchema,
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

function capaError(error: QualityCapaError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" ||
    error.code === "CAPA_NOT_FOUND" ||
    error.code === "CAPA_ACTION_NOT_FOUND"
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

export async function PUT(
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
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid CAPA payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    return apiData(
      await saveCapaPlan({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        actions: parsed.data.actions,
        verificationPlan: parsed.data.verificationPlan,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof QualityCapaError) return capaError(error);
    throw error;
  }
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
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid CAPA transition payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  const common = {
    organizationId: parsed.data.organizationId,
    siteId: parsed.data.siteId,
    eventId,
    actorId: auth.session.user.id,
  };

  try {
    switch (parsed.data.action) {
      case "ACTIVATE":
        return apiData(await activateCapa(common));
      case "SET_ACTION_STATUS":
        return apiData(
          await setCapaActionStatus({
            ...common,
            actionId: parsed.data.actionId,
            status: parsed.data.status,
            completionNote: parsed.data.completionNote,
          }),
        );
      case "START_VERIFICATION":
        return apiData(await startCapaVerification(common));
      case "VERIFY_EFFECTIVENESS":
        return apiData(
          await verifyCapaEffectiveness({
            ...common,
            effective: parsed.data.effective,
            result: parsed.data.result,
          }),
        );
      case "REOPEN":
        return apiData(await reopenIneffectiveCapa(common));
    }
  } catch (error) {
    if (error instanceof QualityCapaError) return capaError(error);
    throw error;
  }
}
