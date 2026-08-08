import { z } from "zod";
import { AccessDeniedError, assertPermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  listPartSuppliers,
  setPartSupplierReference,
  SupplierReferenceError,
} from "@/lib/inventory/suppliers";

const currencySchema = z.string().trim().length(3).transform((value) => value.toUpperCase());

const createSchema = z.object({
  organizationId: z.string().min(1),
  supplierId: z.string().min(1),
  supplierPartNumber: z.string().trim().min(1).max(120),
  preferred: z.boolean().default(false),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  minOrderQuantity: z.number().finite().positive().max(1_000_000_000).nullable().optional(),
  unitCost: z.number().finite().min(0).nullable().optional(),
  currency: currencySchema.default("EUR"),
  active: z.boolean().default(true),
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

function referenceError(error: SupplierReferenceError) {
  const status = error.code === "CROSS_ORGANIZATION_REFERENCE" ? 409 : 404;
  return apiError(status, error.code, error.message);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ partId: string }> },
) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  if (!organizationId) return apiError(400, "ORGANIZATION_REQUIRED", "organizationId is required");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, "inventory:read");
  if (denied) return denied;

  const { partId } = await context.params;
  try {
    return apiData(
      await listPartSuppliers({
        organizationId,
        partId,
        includeInactive: url.searchParams.get("includeInactive") === "true",
      }),
    );
  } catch (error) {
    if (error instanceof SupplierReferenceError) return referenceError(error);
    throw error;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ partId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid supplier reference payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, "inventory:manage");
  if (denied) return denied;

  const { partId } = await context.params;
  try {
    return apiData(
      await setPartSupplierReference({
        organizationId: parsed.data.organizationId,
        partId,
        supplierId: parsed.data.supplierId,
        supplierPartNumber: parsed.data.supplierPartNumber,
        preferred: parsed.data.preferred,
        leadTimeDays: parsed.data.leadTimeDays ?? null,
        minOrderQuantity: parsed.data.minOrderQuantity ?? null,
        unitCost: parsed.data.unitCost ?? null,
        currency: parsed.data.currency,
        active: parsed.data.active,
        actorId: auth.session.user.id,
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof SupplierReferenceError) return referenceError(error);
    throw error;
  }
}
