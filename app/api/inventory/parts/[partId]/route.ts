import { z } from "zod";
import { AccessDeniedError, assertPermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { PartMasterError, updatePart } from "@/lib/inventory/parts";

const updateSchema = z
  .object({
    organizationId: z.string().min(1),
    sku: z.string().trim().min(1).max(80).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    unit: z.string().trim().min(1).max(20).optional(),
    reorderPoint: z.number().finite().min(0).optional(),
    unitCost: z.number().finite().min(0).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "organizationId"),
    "At least one part field must be supplied",
  );

function authorize(scope: Parameters<typeof assertPermission>[0]) {
  try {
    assertPermission(scope, "inventory:manage");
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ partId: string }> }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid part update payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope);
  if (denied) return denied;

  const { partId } = await context.params;
  const { organizationId, ...patch } = parsed.data;
  try {
    return apiData(
      await updatePart({
        organizationId,
        partId,
        patch,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof PartMasterError) {
      return apiError(error.code === "DUPLICATE_SKU" ? 409 : 404, error.code, error.message);
    }
    throw error;
  }
}
