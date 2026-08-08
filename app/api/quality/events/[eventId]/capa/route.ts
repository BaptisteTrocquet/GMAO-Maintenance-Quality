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
  type QualityCapaSnapshot,
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

type SavePayload = z.infer<typeof saveSchema>;

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

function activePlanIntegrityError(current: QualityCapaSnapshot | null, payload: SavePayload) {
  if (!current || current.status !== "ACTIVE") return null;

  const proposedById = new Map(
    payload.actions.flatMap((action) => (action.id ? [[action.id, action] as const] : [])),
  );

  for (const existing of current.actions) {
    const proposed = proposedById.get(existing.id);
    if (!proposed) {
      return apiError(
        409,
        "CAPA_ACTION_REMOVAL_FORBIDDEN",
        "Activated CAPA actions cannot be removed; complete or explicitly transition them instead",
      );
    }

    if (existing.status === "COMPLETED") {
      const proposedDescription = proposed.description?.trim() || null;
      const proposedDueAt = new Date(proposed.dueAt).toISOString();
      if (
        proposed.type !== existing.type ||
        proposed.title.trim() !== existing.title ||
        proposedDescription !== existing.description ||
        proposed.ownerId !== existing.ownerId ||
        proposedDueAt !== existing.dueAt
      ) {
        return apiError(
          409,
          "COMPLETED_CAPA_ACTION_IMMUTABLE",
          "Completed CAPA action definition cannot be rewritten",
        );
      }
    }
  }

  return null;
}

function authenticationError(auth: Awaited<ReturnType<typeof authenticateRequest>>) {
  if (!("error" in auth)) return null;
  return auth.error ?? apiError(401, "UNAUTHENTICATED", "Authentication required");
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<Response> {
  const { eventId } = await params;
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  const authError = authenticationError(auth);
  if (authError) return authError;
  if (!("session" in auth) || !("tenant" in auth)) {
    return apiError(401, "UNAUTHENTICATED", "Authentication required");
  }
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
): Promise<Response> {
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
  const authError = authenticationError(auth);
  if (authError) return authError;
  if (!("session" in auth) || !("tenant" in auth)) {
    return apiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  const workspace = await getCapaWorkspace({
    organizationId: parsed.data.organizationId,
    siteId: parsed.data.siteId,
    eventId,
  });
  if (!workspace) {
    return apiError(404, "QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  const integrityError = activePlanIntegrityError(workspace.capa, parsed.data);
  if (integrityError) return integrityError;

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
): Promise<Response> {
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
  const authError = authenticationError(auth);
  if (authError) return authError;
  if (!("session" in auth) || !("tenant" in auth)) {
    return apiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  if (
    parsed.data.action === "SET_ACTION_STATUS" &&
    parsed.data.status === "COMPLETED" &&
    !parsed.data.completionNote?.trim()
  ) {
    return apiError(
      409,
      "CAPA_ACTION_EVIDENCE_REQUIRED",
      "Completion evidence is required before a CAPA action can be marked completed",
    );
  }

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

  return apiError(400, "INVALID_CAPA_ACTION", "Unsupported CAPA transition action");
}
