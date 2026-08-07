import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  cancelCycleCount,
  CycleCountError,
  getCycleCount,
  recordCycleCountItem,
} from "@/lib/inventory/cycle-counts";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const countItemSchema = scopeSchema.extend({
  partId: z.string().min(1),
  countedQuantity: z.number().finite().min(0).max(1_000_000_000),
});

function authorize(
  scope: Parameters<typeof assertSitePermission>[0],
  siteId: string,
  permission: "inventory:read" | "inventory:manage",
) {
  try {
    assertSitePermission(scope, siteId, permission);
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

function cycleError(error: CycleCountError) {
  const status =
    error.code === "COUNT_NOT_FOUND" || error.code === "PART_NOT_IN_COUNT" ? 404 : 409;
  return apiError(status, error.code, error.message, error.details);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ countId: string }> },
) {
  const url = new URL(request.url);
  const parsed = scopeSchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "inventory:read");
  if (denied) return denied;

  const { countId } = await context.params;
  try {
    return apiData(await getCycleCount({ ...parsed.data, countId }));
  } catch (error) {
    if (error instanceof CycleCountError) return cycleError(error);
    throw error;
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ countId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = countItemSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid cycle count entry", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "inventory:manage");
  if (denied) return denied;

  const { countId } = await context.params;
  try {
    return apiData(
      await recordCycleCountItem({
        ...parsed.data,
        countId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof CycleCountError) return cycleError(error);
    throw error;
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ countId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = scopeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid cycle count cancellation payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "inventory:manage");
  if (denied) return denied;

  const { countId } = await context.params;
  try {
    return apiData(
      await cancelCycleCount({
        ...parsed.data,
        countId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof CycleCountError) return cycleError(error);
    throw error;
  }
}
