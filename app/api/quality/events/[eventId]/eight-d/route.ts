import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  advanceEightD,
  EightDError,
  getEightDWorkspace,
  listEightDTimeline,
  saveEightDWorkspace,
} from "@/lib/quality/eight-d";

const teamMemberSchema = z.object({
  userId: z.string().min(1),
  responsibility: z.string().trim().min(1).max(500),
});

const saveSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  team: z.array(teamMemberSchema).max(30).optional(),
  problemStatement: z.string().trim().max(5000).optional(),
  preventionSummary: z.string().trim().max(5000).optional(),
  systemicChanges: z.array(z.string().trim().min(1).max(1000)).max(50).optional(),
  recognitionNote: z.string().trim().max(5000).optional(),
});

const advanceSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("ADVANCE"),
});

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
    return apiError(400, "INVALID_PAYLOAD", "Invalid 8D payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    return apiData(
      await saveEightDWorkspace({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        team: parsed.data.team,
        problemStatement: parsed.data.problemStatement,
        preventionSummary: parsed.data.preventionSummary,
        systemicChanges: parsed.data.systemicChanges,
        recognitionNote: parsed.data.recognitionNote,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof EightDError) return eightDError(error);
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
  const parsed = advanceSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid 8D transition payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    return apiData(
      await advanceEightD({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof EightDError) return eightDEError(error);
    throw error;
  }
}
