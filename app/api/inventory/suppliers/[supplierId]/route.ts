import { z } from "zod";
import { AccessDeniedError, assertPermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { SupplierReferenceError, updateSupplier } from "@/lib/inventory/suppliers";

const updateSchema = z
  .object({
    organizationId: z.string().min(1),
    code: z.string().trim().min(1).max(80).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    contactName: z.string().trim().max(150).nullable().optional(),
    email: z.string().email().max(320).nullable().optional(),
    phone: z.string().trim().max(80).nullable().optional(),
    website: z.string().url().max(2048).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "organizationId"),
    "At least one supplier field must be supplied",
  );

function denied(scope: Parameters<typeof assertPermission>[0]) {
  try {
    assertPermission(scope, "inventory:manage");
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ supplierId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid supplier update", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const accessDenied = denied(auth.tenant.scope);
  if (accessDenied) return accessDenied;

  const { supplierId } = await context.params;
  const { organizationId, ...patch } = parsed.data;
  try {
    return apiData(
      await updateSupplier({
        organizationId,
        supplierId,
        patch,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof SupplierReferenceError) {
      return apiError(
        error.code === "DUPLICATE_SUPPLIER_CODE" ? 409 : 404,
        error.code,
        error.message,
      );
    }
    throw error;
  }
}
