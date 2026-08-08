import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  approveCapaWithSeparation,
  CapaApprovalError,
} from "@/lib/quality/capa-approval";
import {
  CapaError,
  completeCapaAction,
  getCapaWorkspace,
  listCapaTimeline,
  reopenCapa,
  saveCapaDraft,
  verifyCapaEffectiveness,
} from "@/lib/quality/capa";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const actionSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(["CORRECTIVE", "PREVENTIVE"]),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(5000).nullable().optional(),
  ownerId: z.string().min(1),
  dueAt: z.coerce.date(),
});

const saveSchema = scopeSchema.extend({
  action: z.literal("SAVE"),
  planSummary: z.string().trim().min(1).max(5000),
  actions: z.array(actionSchema).max(100),
});

const approveSchema = scopeSchema.extend({
  action: z.literal("APPROVE"),
  approvalNote: z.string().trim().max(5000).nullable().optional(),
});
const completeActionSchema = scopeSchema.extend({
  action: z.literal("COMPLETE_ACTION"),
  actionId: z.string().uuid(),
  completionNote: z.string().trim().min(1).max(5000),
});
const verifySchema = scopeSchema.extend({
  action: z.literal("VERIFY_EFFECTIVENESS"),
  result: z.enum(["EFFECTIVE", "INEFFECTIVE"]),
  note: z.string().trim().min(1).max(5000),
});
const reopenSchema = scopeSchema.extend({ action: z.literal("REOPEN") });

const patchSchema = z.discriminatedUnion("action", [
  saveSchema,
  approveSchema,
  completeActionSchema,
  verifySchema,
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

function workflowError(error: CapaError | CapaApprovalError) {
  if (error instanceof CapaApprovalError) {
    const status =
      error.code === "QUALITY_EVENT_NOT_FOUND" ||
      error.code === "CAPA_NOT_FOUND" ||
      error.code === "ACTION_OWNER_NOT_FOUND"
        ? 404
        : error.code === "CAPA_APPROVER_NOT_ALLOWED" ||
            error.code === "CAPA_SELF_APPROVAL_NOT_ALLOWED"
          ? 403
          : 409;
    return apiError(status, error.code, error.message);
  }

  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" ||
    error.code === "CAPA_NOT_FOUND" ||
    error.code === "ACTION_NOT_FOUND" ||
    error.code === "ACTION_OWNER_NOT_FOUND"
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid CAPA payload", parsed.error.flatten());
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
          planSummary: parsed.data.planSummary,
          actions: parsed.data.actions,
          actorId: auth.session.user.id,
        }),
      );
    }

    if (parsed.data.action === "APPROVE") {
      return apiData(
        await approveCapaWithSeparation({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          approverId: auth.session.user.id,
          approvalNote: parsed.data.approvalNote,
        }),
      );
    }

    if (parsed.data.action === "COMPLETE_ACTION") {
      return apiData(
        await completeCapaAction({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          actionId: parsed.data.actionId,
          completionNote: parsed.data.completionNote,
          actorId: auth.session.user.id,
        }),
      );
    }

    if (parsed.data.action === "VERIFY_EFFECTIVENESS") {
      return apiData(
        await verifyCapaEffectiveness({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          result: parsed.data.result,
          note: parsed.data.note,
          actorId: auth.session.user.id,
        }),
      );
    }

    return apiData(
      await reopenCapa({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof CapaError || error instanceof CapaApprovalError) {
      return workflowError(error);
    }
    throw error;
  }
}
