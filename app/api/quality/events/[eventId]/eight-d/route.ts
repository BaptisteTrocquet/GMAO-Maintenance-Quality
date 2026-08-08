import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  approveEightD,
  closeEightD,
  EightDError,
  getEightDWorkspace,
  listEightDTimeline,
  recordEightDPrevention,
  reopenEightD,
  saveEightDDraft,
} from "@/lib/quality/eight-d";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const saveSchema = scopeSchema.extend({
  action: z.literal("SAVE"),
  leaderId: z.string().min(1),
  teamMemberIds: z.array(z.string().min(1)).max(50),
  problemStatement: z.string().trim().min(1).max(5000),
});
const approveSchema = scopeSchema.extend({ action: z.literal("APPROVE") });
const preventionSchema = scopeSchema.extend({
  action: z.literal("RECORD_PREVENTION"),
  preventionSummary: z.string().trim().min(1).max(5000),
});
const closeSchema = scopeSchema.extend({
  action: z.literal("CLOSE"),
  recognitionNote: z.string().trim().min(1).max(5000),
});
const reopenSchema = scopeSchema.extend({ action: z.literal("REOPEN") });

const patchSchema = z.discriminatedUnion("action", [
  saveSchema,
  approveSchema,
  preventionSchema,
  closeSchema,
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

function eightDError(error: EightDError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" ||
    error.code === "EIGHT_D_NOT_FOUND" ||
    error.code === "TEAM_MEMBER_NOT_FOUND"
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

  const workspace = await getEightDWorkspace({ organizationId, siteId, eventId });
  if (!workspace) {
    return apiError(404, "QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  const timeline = await listEightDTimeline({ organizationId, siteId, eventId });
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid 8D payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    if (parsed.data.action === "SAVE") {
      return apiData(
        await saveEightDDraft({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          leaderId: parsed.data.leaderId,
          teamMemberIds: parsed.data.teamMemberIds,
          problemStatement: parsed.data.problemStatement,
          actorId: auth.session.user.id,
        }),
      );
    }
    if (parsed.data.action === "APPROVE") {
      return apiData(
        await approveEightD({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          actorId: auth.session.user.id,
        }),
      );
    }
    if (parsed.data.action === "RECORD_PREVENTION") {
      return apiData(
        await recordEightDPrevention({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          preventionSummary: parsed.data.preventionSummary,
          actorId: auth.session.user.id,
        }),
      );
    }
    if (parsed.data.action === "CLOSE") {
      return apiData(
        await closeEightD({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          recognitionNote: parsed.data.recognitionNote,
          actorId: auth.session.user.id,
        }),
      );
    }
    return apiData(
      await reopenEightD({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof EightDError) return eightDError(error);
    throw error;
  }
}
