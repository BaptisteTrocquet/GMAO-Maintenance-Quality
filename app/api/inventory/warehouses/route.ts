import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  createWarehouse,
  InventoryLocationError,
  listWarehouses,
} from "@/lib/inventory/warehouses";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(150),
  description: z.string().max(2000).nullable().optional(),
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

function inventoryError(error: InventoryLocationError) {
  const status = error.code.startsWith("DUPLICATE_") ? 409 : 404;
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

  try {
    return apiData(
      await listWarehouses({
        organizationId,
        siteId,
        includeInactive: url.searchParams.get("includeInactive") === "true",
      }),
    );
  } catch (error) {
    if (error instanceof InventoryLocationError) return inventoryError(error);
    throw error;
  }
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid warehouse payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "inventory:manage");
  if (denied) return denied;

  try {
    return apiData(
      await createWarehouse({
        ...parsed.data,
        actorId: auth.session.user.id,
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof InventoryLocationError) return inventoryError(error);
    throw error;
  }
}
