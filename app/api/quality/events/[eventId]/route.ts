import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  completeContainment,
  getQualityEvent,
  listQualityEventTimeline,
  QualityEventError,
  startOrUpdateContainment,
  updateQualityEvent,
} from "@/lib/quality/events";

const eventTypes = [
  "NONCONFORMITY",
  "OBSERVATION",
  "AUDIT_FINDING",
  "COMPLAINT",
  "DEVIATION",
  "OTHER",
] as const;
const severities = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const updateSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("UPDATE"),
  type: z.enum(eventTypes).optional(),
  severity: z.enum(severities).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  occurredAt: z.string().datetime().nullable().optional(),
});

const containmentSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("START_CONTAINMENT"),
  summary: z.string().trim().min(1).max(4000),
  ownerId: z.string().min(1).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
});

const completeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("COMPLETE_CONTAINMENT"),
  completionNote: z.string().trim().max(4000).nullable().optional(),
});

const patchSchema = z.discriminatedUnion("action", [
  updateSchema,
  containmentSchema,
  completeSchema,
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
    error.code === "SITE_NOT_FOUND" ||
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
  if (!qualityEvent) return apiError(404, "QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
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

  if (
    parsed.data.action === "UPDATE" &&
    parsed.data.type === undefined &&
    parsed.data.severity === undefined &&
    parsed.data.title === undefined &&
    parsed.data.description === undefined &&
    parsed.data.occurredAt === undefined
  ) {
    return apiError(400, "NO_CHANGES", "At least one quality event field must be supplied");
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    if (parsed.data.action === "UPDATE") {
      return apiData(
        await updateQualityEvent({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          type: parsed.data.type,
          severity: parsed.data.severity,
          title: parsed.data.title,
          description: parsed.data.description,
          occurredAt:
            parsed.data.occurredAt === undefined
              ? undefined
              : parsed.data.occurredAt
                ? new Date(parsed.data.occurredAt)
                : null,
          actorId: auth.session.user.id,
        }),
      );
    }

    if (parsed.data.action === "START_CONTAINMENT") {
      return apiData(
        await startOrUpdateContainment({
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
          actorId: auth.session.user.id,
        }),
      );
    }

    return apiData(
      await completeContainment({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        completionNote: parsed.data.completionNote,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof QualityEventError) return qualityError(error);
    throw error;
  }
}
