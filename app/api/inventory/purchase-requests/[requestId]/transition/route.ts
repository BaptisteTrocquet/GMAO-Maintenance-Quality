import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  PurchaseRequestError,
  transitionPurchaseRequest,
} from "@/lib/inventory/purchase-requests";

const transitionSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  action: z.enum(["SUBMIT", "APPROVE", "REJECT", "CANCEL"]),
  note: z.string().trim().max(1000).nullable().optional(),
});

function authorize(scope: Parameters<typeof assertSitePermission>[0], siteId: string) {
  try {
    assertSitePermission(scope, siteId, "inventory:manage");
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid purchase request transition", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId);
  if (denied) return denied;

  try {
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
  } catch (error) {
    if (error instanceof PurchaseRequestError) return purchaseError(error);
    throw error;
  }
}
