import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { getCapaWorkspace } from "@/lib/quality/capa";
import { getEightDWorkspace } from "@/lib/quality/eight-d";
import {
  getQualityEvent,
  listQualityEventTimeline,
  QualityEventError,
  setImmediateContainment,
  transitionQualityEvent,
} from "@/lib/quality/events";

const containmentSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("SET_CONTAINMENT"),
  summary: z.string().trim().min(1).max(5000),
  ownerId: z.string().min(1).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
});

const investigationSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("START_INVESTIGATION"),
});

const closeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("CLOSE"),
  resolutionSummary: z.string().trim().min(1).max(5000),
});

const reopenSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("REOPEN"),
});

const patchSchema = z.discriminatedUnion("action", [
  containmentSchema,
  investigationSchema,
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

function qualityError(error: QualityEventError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" ||
    error.code === "CONTAINMENT_OWNER_NOT_FOUND"
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

  const qualityEvent = await getQualityEvent({ organizationId, siteId, eventId });
  if (!qualityEvent) {
    return apiError(404, "QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  const timeline = await listQualityEventTimeline({ organizationId, siteId, eventId });
  return apiData({ qualityEvent, timeline: timeline ?? [] });
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid quality event workflow payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    if (parsed.data.action === "SET_CONTAINMENT") {
      return apiData(
        await setImmediateContainment({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          summary: parsed.data.summary,
          ownerId: parsed.data.ownerId,
          dueAt:
            parsed.data.dueAt === undefined
              ? undefined
              : parsed.data.dueAt
                ? new Date(parsed.data.dueAt)
                : null,
          completedAt:
            parsed.data.completedAt === undefined
              ? undefined
              : parsed.data.completedAt
                ? new Date(parsed.data.completedAt)
                : null,
          actorId: auth.session.user.id,
        }),
      );
    }

    if (parsed.data.action === "CLOSE") {
      const [capaWorkspace, eightDWorkspace] = await Promise.all([
        getCapaWorkspace({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
        }),
        getEightDWorkspace({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
        }),
      ]);
      if (capaWorkspace?.capa && capaWorkspace.capa.status !== "CLOSED") {
        return apiError(
          409,
          "CAPA_INCOMPLETE",
          "Close or resolve the active CAPA before closing this quality event",
        );
      }
      if (eightDWorkspace?.eightD && eightDWorkspace.eightD.status !== "CLOSED") {
        return apiError(
          409,
          "EIGHT_D_INCOMPLETE",
          "Close the active 8D before closing this quality event",
        );
      }
    }

    return apiData(
      await transitionQualityEvent({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        action: parsed.data.action,
        resolutionSummary:
          parsed.data.action === "CLOSE" ? parsed.data.resolutionSummary : undefined,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof QualityEventError) return qualityError(error);
    throw error;
  }
}
