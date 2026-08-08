import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  createQualityEvent,
  listQualityEvents,
  QualityEventError,
  type QualityEventStatus,
  type QualityEventType,
  type QualitySeverity,
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
const statuses = ["OPEN", "CONTAINED", "INVESTIGATING", "CLOSED"] as const;

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  eventKey: z.string().trim().min(1).max(120),
  type: z.enum(eventTypes),
  severity: z.enum(severities),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(5000).nullable().optional(),
  occurredAt: z.string().datetime().nullable().optional(),
  assetId: z.string().min(1).nullable().optional(),
  workOrderId: z.string().min(1).nullable().optional(),
  documentIds: z.array(z.string().min(1)).max(50).optional(),
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

function qualityError(error: QualityEventError) {
  const status =
    error.code === "SITE_NOT_FOUND" ||
    error.code === "ASSET_NOT_FOUND" ||
    error.code === "WORK_ORDER_NOT_FOUND" ||
    error.code === "DOCUMENT_NOT_FOUND" ||
    error.code === "QUALITY_EVENT_NOT_FOUND" ||
    error.code === "CONTAINMENT_OWNER_NOT_FOUND"
      ? 404
      : 409;
  return apiError(status, error.code, error.message);
}

function enumQuery<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | undefined | null {
  if (!value) return undefined;
  return allowed.includes(value as T) ? (value as T) : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const status = enumQuery<QualityEventStatus>(url.searchParams.get("status"), statuses);
  const type = enumQuery<QualityEventType>(url.searchParams.get("type"), eventTypes);
  const severity = enumQuery<QualitySeverity>(url.searchParams.get("severity"), severities);
  if (status === null || type === null || severity === null) {
    return apiError(400, "INVALID_FILTER", "Unsupported quality event filter");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, siteId, "quality:read");
  if (denied) return denied;

  return apiData(await listQualityEvents({ organizationId, siteId, status, type, severity }));
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid quality event payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "quality:manage");
  if (denied) return denied;

  try {
    const result = await createQualityEvent({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      eventKey: parsed.data.eventKey,
      type: parsed.data.type,
      severity: parsed.data.severity,
      title: parsed.data.title,
      description: parsed.data.description,
      occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : null,
      assetId: parsed.data.assetId,
      workOrderId: parsed.data.workOrderId,
      documentIds: parsed.data.documentIds,
      actorId: auth.session.user.id,
    });
    return apiData(result, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    if (error instanceof QualityEventError) return qualityError(error);
    throw error;
  }
}
