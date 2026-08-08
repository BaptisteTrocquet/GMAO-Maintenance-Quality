import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  getRootCauseAnalysis,
  listRootCauseTimeline,
  RootCauseAnalysisError,
  saveRootCauseAnalysis,
  transitionRootCauseAnalysis,
} from "@/lib/quality/root-cause";

const saveSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  problemStatement: z.string().trim().min(1).max(5000),
  fiveWhys: z.array(z.string().trim().min(1).max(2000)).max(5),
  rootCauseConclusion: z.string().trim().max(5000).nullable().optional(),
});

const transitionSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.enum(["COMPLETE", "REOPEN"]),
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

function analysisError(error: RootCauseAnalysisError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" || error.code === "ANALYSIS_NOT_FOUND"
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

  const [analysis, timeline] = await Promise.all([
    getRootCauseAnalysis({ organizationId, siteId, eventId }),
    listRootCauseTimeline({ organizationId, siteId, eventId }),
  ]);
  return apiData({ analysis, timeline });
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid root-cause payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    return apiData(
      await saveRootCauseAnalysis({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        problemStatement: parsed.data.problemStatement,
        fiveWhys: parsed.data.fiveWhys,
        rootCauseConclusion: parsed.data.rootCauseConclusion,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof RootCauseAnalysisError) return analysisError(error);
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid root-cause transition", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    return apiData(
      await transitionRootCauseAnalysis({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        action: parsed.data.action,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof RootCauseAnalysisError) return analysisError(error);
    throw error;
  }
}
