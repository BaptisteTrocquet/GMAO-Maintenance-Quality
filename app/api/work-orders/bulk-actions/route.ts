import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  BULK_WORK_ORDER_LIMIT,
  BulkWorkOrderError,
  bulkTriageWorkOrders,
  listBulkActionOptions,
} from "@/lib/work-orders/bulk-actions";

const operationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SET_PRIORITY"),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
  }),
  z.object({
    type: z.literal("SET_ASSIGNEE"),
    assigneeId: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal("SET_TEAM"),
    teamId: z.string().min(1).nullable(),
  }),
]);

const bulkSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  workOrderIds: z.array(z.string().min(1)).min(1).max(BULK_WORK_ORDER_LIMIT),
  operation: operationSchema,
});

function accessError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

function bulkError(error: BulkWorkOrderError) {
  switch (error.code) {
    case "EMPTY_SELECTION":
    case "BATCH_TOO_LARGE":
      return apiError(400, error.code, error.message);
    case "WORK_ORDER_SCOPE_MISMATCH":
    case "ASSIGNEE_NOT_FOUND":
    case "TEAM_NOT_FOUND":
      return apiError(404, error.code, error.message);
  }
}

async function authorize(request: Request, organizationId: string, siteId: string) {
  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) {
    return { error: auth.error ?? apiError(401, "UNAUTHENTICATED", "Authentication required") } as const;
  }
  try {
    assertSitePermission(auth.tenant.scope, siteId, "work:manage");
  } catch (error) {
    return { error: accessError(error) } as const;
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
  if (!site) return { error: apiError(404, "SITE_NOT_FOUND", "Active site not found") } as const;
  return { auth } as const;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const authorization = await authorize(request, organizationId, siteId);
  if ("error" in authorization) return authorization.error;

  return apiData(await listBulkActionOptions({ organizationId, siteId }));
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid bulk action payload", parsed.error.flatten());
  }

  const authorization = await authorize(
    request,
    parsed.data.organizationId,
    parsed.data.siteId,
  );
  if ("error" in authorization) return authorization.error;

  try {
    return apiData(
      await bulkTriageWorkOrders({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        workOrderIds: parsed.data.workOrderIds,
        operation: parsed.data.operation,
        actorId: authorization.auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof BulkWorkOrderError) return bulkError(error);
    throw error;
  }
}
