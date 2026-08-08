import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { getQualityEvent } from "@/lib/quality/events";
import {
  finalizeQualityRca,
  getQualityRca,
  listQualityRcaTimeline,
  QualityRcaError,
  saveQualityRca,
} from "@/lib/quality/root-cause";

const categories = [
  "PEOPLE",
  "MACHINE",
  "METHOD",
  "MATERIAL",
  "MEASUREMENT",
  "ENVIRONMENT",
] as const;

const saveSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  problemStatement: z.string().trim().min(1).max(5000),
  fiveWhys: z.array(z.object({
    sequence: z.number().int().min(1).max(5),
    answer: z.string().trim().max(2000),
  })).max(5),
  ishikawaCauses: z.array(z.object({
    category: z.enum(categories),
    statement: z.string().trim().max(2000),
  })).max(100),
  rootCauses: z.array(z.object({
    source: z.enum(["FIVE_WHY", "ISHIKAWA"]),
    refId: z.string().min(1),
  })).max(20),
});

const finalizeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.literal("FINALIZE"),
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

function rcaError(error: QualityRcaError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" || error.code === "RCA_NOT_FOUND" ? 404 : 409;
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

  const rca = await getQualityRca({ organizationId, siteId, eventId });
  if (!rca) return apiData({ rca: null, timeline: [] });
  const timeline = await listQualityRcaTimeline({ organizationId, siteId, eventId });
  return apiData({ rca, timeline: timeline ?? [] });
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid RCA payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    return apiData(
      await saveQualityRca({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        problemStatement: parsed.data.problemStatement,
        fiveWhys: parsed.data.fiveWhys,
        ishikawaCauses: parsed.data.ishikawaCauses,
        rootCauses: parsed.data.rootCauses,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof QualityRcaError) return rcaError(error);
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
  const parsed = finalizeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid RCA transition payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    return apiData(
      await finalizeQualityRca({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof QualityRcaError) return rcaError(error);
    throw error;
  }
}
