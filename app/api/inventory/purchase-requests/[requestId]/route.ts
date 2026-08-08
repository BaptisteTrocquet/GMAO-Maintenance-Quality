import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  getPurchaseRequest,
  PurchaseRequestError,
  transitionPurchaseRequest,
  updatePurchaseRequestDraft,
} from "@/lib/inventory/purchase-requests";

const lineSchema = z.object({
  partId: z.string().min(1),
  supplierId: z.string().min(1).nullable().optional(),
  quantity: z.number().finite().positive(),
});

const patchSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.enum(["SUBMIT", "APPROVE", "REJECT", "CANCEL"]).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  reason: z.string().trim().max(1000).nullable().optional(),
  neededBy: z.string().datetime().nullable().optional(),
  lines: z.array(lineSchema).min(1).max(100).optional(),
}).superRefine((value, ctx) => {
  if (value.action && value.lines) {
    ctx.addIssue({ code: "custom", message: "Transitions cannot modify purchase request lines" });
  }
  if (!value.action && !value.lines) {
    ctx.addIssue({ code: "custom", message: "Draft update requires lines" });
  }
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

function purchaseError(error: PurchaseRequestError) {
  const status = error.code === "PURCHASE_REQUEST_NOT_FOUND" ? 404 : 409;
  return apiError(status, error.code, error.message);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
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

  const purchaseRequest = await getPurchaseRequest({ organizationId, siteId, requestId });
  if (!purchaseRequest) {
    return apiError(404, "PURCHASE_REQUEST_NOT_FOUND", "Purchase request not found in site scope");
  }
  return apiData(purchaseRequest);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid purchase request payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "inventory:manage");
  if (denied) return denied;

  try {
    if (parsed.data.action) {
      return apiData(
        await transitionPurchaseRequest({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          requestId,
          action: parsed.data.action,
          note: parsed.data.note,
          actorId: auth.session.user.id,
        }),
      );
    }

    return apiData(
      await updatePurchaseRequestDraft({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        requestId,
        reason: parsed.data.reason,
        neededBy: parsed.data.neededBy ? new Date(parsed.data.neededBy) : null,
        lines: parsed.data.lines ?? [],
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof PurchaseRequestError) return purchaseError(error);
    throw error;
  }
}
