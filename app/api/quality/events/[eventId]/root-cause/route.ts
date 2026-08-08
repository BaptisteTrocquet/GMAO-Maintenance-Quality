import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  confirmRootCauseWorkspace,
  getRootCauseWorkspace,
  listRootCauseTimeline,
  reopenRootCauseWorkspace,
  RootCauseError,
  saveRootCauseWorkspace,
} from "@/lib/quality/root-cause";

const methods = ["FIVE_WHYS", "ISHIKAWA", "COMBINED"] as const;
const categories = [
  "PEOPLE",
  "METHOD",
  "MACHINE",
  "MATERIAL",
  "MEASUREMENT",
  "ENVIRONMENT",
] as const;

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const fiveWhySchema = z.object({
  sequence: z.number().int().min(1).max(5),
  prompt: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(2000),
});

const ishikawaSchema = z.object({
  category: z.enum(categories),
  cause: z.string().trim().min(1).max(1000),
  evidence: z.string().trim().max(2000).nullable().optional(),
});

const saveSchema = scopeSchema.extend({
  action: z.literal("SAVE"),
  method: z.enum(methods),
  problemStatement: z.string().trim().min(1).max(5000),
  fiveWhys: z.array(fiveWhySchema).max(5).optional(),
  ishikawa: z.array(ishikawaSchema).max(100).optional(),
  rootCauseSummary: z.string().trim().max(5000).nullable().optional(),
});

const confirmSchema = scopeSchema.extend({ action: z.literal("CONFIRM") });
const reopenSchema = scopeSchema.extend({ action: z.literal("REOPEN") });
const patchSchema = z.discriminatedUnion("action", [saveSchema, confirmSchema, reopenSchema]);

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

function rootCauseError(error: RootCauseError) {
  const status =
    error.code === "QUALITY_EVENT_NOT_FOUND" || error.code === "ROOT_CAUSE_NOT_FOUND"
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

  const workspace = await getRootCauseWorkspace({ organizationId, siteId, eventId });
  if (!workspace) {
    return apiError(404, "QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  const timeline = await listRootCauseTimeline({ organizationId, siteId, eventId });
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid root-cause payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    if (parsed.data.action === "SAVE") {
      return apiData(
        await saveRootCauseWorkspace({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          method: parsed.data.method,
          problemStatement: parsed.data.problemStatement,
          fiveWhys: parsed.data.fiveWhys,
          ishikawa: parsed.data.ishikawa?.map((cause) => ({
            ...cause,
            evidence: cause.evidence ?? null,
          })),
          rootCauseSummary: parsed.data.rootCauseSummary,
          actorId: auth.session.user.id,
        }),
      );
    }

    if (parsed.data.action === "CONFIRM") {
      return apiData(
        await confirmRootCauseWorkspace({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          eventId,
          actorId: auth.session.user.id,
        }),
      );
    }

    return apiData(
      await reopenRootCauseWorkspace({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        eventId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof RootCauseError) return rootCauseError(error);
    throw error;
  }
}
