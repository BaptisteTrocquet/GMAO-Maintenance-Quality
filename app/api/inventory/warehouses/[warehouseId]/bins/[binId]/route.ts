import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { InventoryLocationError, updateStockBin } from "@/lib/inventory/warehouses";

const updateSchema = z
  .object({
    organizationId: z.string().min(1),
    siteId: z.string().min(1),
    code: z.string().trim().min(1).max(50).optional(),
    name: z.string().trim().min(1).max(150).optional(),
    description: z.string().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "organizationId" && key !== "siteId"),
    "At least one stock-bin field must be supplied",
  );

function denied(scope: Parameters<typeof assertSitePermission>[0], siteId: string) {
  try {
    assertSitePermission(scope, siteId, "inventory:manage");
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ warehouseId: string; binId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid stock-bin update", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const accessDenied = denied(auth.tenant.scope, parsed.data.siteId);
  if (accessDenied) return accessDenied;

  const { warehouseId, binId } = await context.params;
  const { organizationId, siteId, ...patch } = parsed.data;
  try {
    return apiData(
      await updateStockBin({
        organizationId,
        siteId,
        warehouseId,
        binId,
        patch,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof InventoryLocationError) {
      return apiError(error.code.startsWith("DUPLICATE_") ? 409 : 404, error.code, error.message);
    }
    throw error;
  }
}
