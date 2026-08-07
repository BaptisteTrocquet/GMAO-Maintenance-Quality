import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  disableReorderPolicy,
  listReorderPolicies,
  ReorderPolicyError,
  setReorderPolicy,
} from "@/lib/inventory/reorder";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const policySchema = scopeSchema.extend({
  binId: z.string().min(1),
  partId: z.string().min(1),
  minQuantity: z.number().finite().min(0).max(1_000_000_000),
  maxQuantity: z.number().finite().min(0).max(1_000_000_000),
  reorderQuantity: z.number().finite().positive().max(1_000_000_000).nullable().optional(),
});

const disableSchema = scopeSchema.extend({
  binId: z.string().min(1),
  partId: z.string().min(1),
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

function policyError(error: ReorderPolicyError) {
  const status = error.code === "BIN_NOT_FOUND" || error.code === "PART_NOT_FOUND" || error.code === "POLICY_NOT_FOUND" ? 404 : 409;
  return apiError(status, error.code, error.message);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, siteId, "inventory:read");
  if (denied) return denied;

  return apiData(
    await listReorderPolicies({
      organizationId,
      siteId,
      includeInactive: url.searchParams.get("includeInactive") === "true",
    }),
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = policySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid reorder policy payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "inventory:manage");
  if (denied) return denied;

  try {
    return apiData(
      await setReorderPolicy({
        ...parsed.data,
        actorId: auth.session.user.id,
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ReorderPolicyError) return policyError(error);
    throw error;
  }
}

export async function DELETE(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = disableSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid reorder policy disable payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "inventory:manage");
  if (denied) return denied;

  try {
    return apiData(
      await disableReorderPolicy({
        ...parsed.data,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof ReorderPolicyError) return policyError(error);
    throw error;
  }
}
