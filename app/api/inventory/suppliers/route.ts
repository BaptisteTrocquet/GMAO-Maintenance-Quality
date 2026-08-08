import { z } from "zod";
import { AccessDeniedError, assertPermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  createSupplier,
  listSuppliers,
  SupplierReferenceError,
} from "@/lib/inventory/suppliers";

const createSchema = z.object({
  organizationId: z.string().min(1),
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(150).nullable().optional(),
  email: z.string().email().max(320).nullable().optional(),
  phone: z.string().trim().max(80).nullable().optional(),
  website: z.string().url().max(2048).nullable().optional(),
});

function authorize(
  scope: Parameters<typeof assertPermission>[0],
  permission: "inventory:read" | "inventory:manage",
) {
  try {
    assertPermission(scope, permission);
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

function supplierError(error: SupplierReferenceError) {
  return apiError(
    error.code === "DUPLICATE_SUPPLIER_CODE" ? 409 : 404,
    error.code,
    error.message,
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  if (!organizationId) return apiError(400, "ORGANIZATION_REQUIRED", "organizationId is required");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, "inventory:read");
  if (denied) return denied;

  return apiData(
    await listSuppliers({
      organizationId,
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
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid supplier payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, "inventory:manage");
  if (denied) return denied;

  try {
    return apiData(
      await createSupplier({
        ...parsed.data,
        actorId: auth.session.user.id,
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof SupplierReferenceError) return supplierError(error);
    throw error;
  }
}
