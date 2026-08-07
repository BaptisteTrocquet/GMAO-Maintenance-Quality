import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  listStockMovements,
  recordStockMovement,
  StockMovementError,
} from "@/lib/inventory/stock";

const postSchema = z
  .object({
    organizationId: z.string().min(1),
    siteId: z.string().min(1),
    binId: z.string().min(1),
    partId: z.string().min(1),
    type: z.enum(["RECEIPT", "ISSUE", "ADJUSTMENT"]),
    quantity: z.number().finite().positive().max(1_000_000_000).optional(),
    targetQuantity: z.number().finite().min(0).max(1_000_000_000).optional(),
    unitCost: z.number().finite().min(0).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    referenceType: z.string().trim().max(100).nullable().optional(),
    referenceId: z.string().trim().max(200).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "ADJUSTMENT") {
      if (value.targetQuantity === undefined) {
        ctx.addIssue({ code: "custom", path: ["targetQuantity"], message: "targetQuantity is required for adjustment" });
      }
      if (value.quantity !== undefined) {
        ctx.addIssue({ code: "custom", path: ["quantity"], message: "quantity is not used for adjustment" });
      }
    } else {
      if (value.quantity === undefined) {
        ctx.addIssue({ code: "custom", path: ["quantity"], message: "quantity is required for receipt or issue" });
      }
      if (value.targetQuantity !== undefined) {
        ctx.addIssue({ code: "custom", path: ["targetQuantity"], message: "targetQuantity is only used for adjustment" });
      }
    }
  });

function stockError(error: StockMovementError) {
  const status =
    error.code === "PART_NOT_FOUND" || error.code === "BIN_NOT_FOUND"
      ? 404
      : error.code === "IDEMPOTENCY_CONFLICT"
        ? 409
        : 409;
  return apiError(status, error.code, error.message);
}

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

  const rawTake = Number(url.searchParams.get("take") ?? 100);
  const take = Number.isFinite(rawTake) ? rawTake : 100;
  return apiData(
    await listStockMovements({
      organizationId,
      siteId,
      partId: url.searchParams.get("partId") ?? undefined,
      binId: url.searchParams.get("binId") ?? undefined,
      take,
    }),
  );
}

export async function POST(request: Request) {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return apiError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A unique Idempotency-Key header between 8 and 200 characters is required",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid stock movement payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "inventory:manage");
  if (denied) return denied;

  try {
    const result = await recordStockMovement({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      binId: parsed.data.binId,
      partId: parsed.data.partId,
      type: parsed.data.type,
      quantity: parsed.data.quantity,
      targetQuantity: parsed.data.targetQuantity,
      idempotencyKey,
      actorId: auth.session.user.id,
      unitCost: parsed.data.unitCost ?? null,
      note: parsed.data.note ?? null,
      referenceType: parsed.data.referenceType ?? null,
      referenceId: parsed.data.referenceId ?? null,
    });
    return apiData(result, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    if (error instanceof StockMovementError) return stockError(error);
    throw error;
  }
}
