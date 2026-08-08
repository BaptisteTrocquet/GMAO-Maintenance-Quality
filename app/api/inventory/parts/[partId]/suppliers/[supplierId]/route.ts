import { z } from "zod";
import { AccessDeniedError, assertPermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  disablePartSupplierReference,
  SupplierReferenceError,
} from "@/lib/inventory/suppliers";

const disableSchema = z.object({ organizationId: z.string().min(1) });

export async function DELETE(
  request: Request,
  context: { params: Promise<{ partId: string; supplierId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = disableSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid supplier reference disable payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertPermission(auth.tenant.scope, "inventory:manage");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const { partId, supplierId } = await context.params;
  try {
    return apiData(
      await disablePartSupplierReference({
        organizationId: parsed.data.organizationId,
        partId,
        supplierId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof SupplierReferenceError) {
      return apiError(
        error.code === "CROSS_ORGANIZATION_REFERENCE" ? 409 : 404,
        error.code,
        error.message,
      );
    }
    throw error;
  }
}
