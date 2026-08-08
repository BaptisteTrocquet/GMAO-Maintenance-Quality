import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  createPurchaseRequest,
  listPurchaseRequests,
  PurchaseRequestError,
  type PurchaseRequestStatus,
} from "@/lib/inventory/purchase-requests";

const lineSchema = z.object({
  partId: z.string().min(1),
  supplierId: z.string().min(1).nullable().optional(),
  quantity: z.number().finite().positive(),
});

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  requestKey: z.string().trim().min(1).max(120),
  reason: z.string().trim().max(1000).nullable().optional(),
  neededBy: z.string().datetime().nullable().optional(),
  lines: z.array(lineSchema).min(1).max(100),
});

const statuses = new Set<PurchaseRequestStatus>([
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);

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

function purchaseError(error: PurchaseRequestError) {
  const status =
    error.code === "SITE_NOT_FOUND" ||
    error.code === "PART_NOT_FOUND" ||
    error.code === "SUPPLIER_REFERENCE_NOT_FOUND" ||
    error.code === "PURCHASE_REQUEST_NOT_FOUND"
      ? 404
      : error.code === "INVALID_LINE_QUANTITY"
        ? 400
        : 409;
  return apiError(status, error.code, error.message);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const statusParam = url.searchParams.get("status");
  const status =
    statusParam && statuses.has(statusParam as PurchaseRequestStatus)
      ? (statusParam as PurchaseRequestStatus)
      : undefined;
  if (statusParam && !status) {
    return apiError(400, "INVALID_STATUS", "Unsupported purchase request status");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, siteId, "inventory:read");
  if (denied) return denied;

  return apiData(await listPurchaseRequests({ organizationId, siteId, status }));
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid purchase request payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "inventory:manage");
  if (denied) return denied;

  try {
    const result = await createPurchaseRequest({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      requestKey: parsed.data.requestKey,
      reason: parsed.data.reason,
      neededBy: parsed.data.neededBy ? new Date(parsed.data.neededBy) : null,
      lines: parsed.data.lines,
      actorId: auth.session.user.id,
    });
    return apiData(result, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    if (error instanceof PurchaseRequestError) return purchaseError(error);
    throw error;
  }
}
