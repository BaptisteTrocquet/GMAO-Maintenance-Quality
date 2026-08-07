import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  listWorkOrderReservations,
  releaseWorkOrderStock,
  reserveWorkOrderStock,
  StockReservationError,
} from "@/lib/inventory/reservations";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const reserveSchema = scopeSchema.extend({
  binId: z.string().min(1),
  partId: z.string().min(1),
  quantity: z.number().finite().positive().max(1_000_000_000),
});

const releaseSchema = scopeSchema.extend({
  binId: z.string().min(1),
  partId: z.string().min(1),
});

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
}

function reservationError(error: StockReservationError) {
  const status =
    error.code === "WORK_ORDER_NOT_FOUND" ||
    error.code === "BIN_NOT_FOUND" ||
    error.code === "PART_NOT_FOUND" ||
    error.code === "RESERVATION_NOT_FOUND"
      ? 404
      : 409;
  return apiError(status, error.code, error.message);
}

async function requireWorkOrder(
  organizationId: string,
  siteId: string,
  workOrderId: string,
) {
  return db.workOrder.findFirst({
    where: {
      id: workOrderId,
      siteId,
      site: { organizationId, active: true },
    },
    select: { id: true, siteId: true },
  });
}

function authorizeRead(scope: Parameters<typeof assertSitePermission>[0], siteId: string) {
  try {
    assertSitePermission(scope, siteId, "work:read");
    assertSitePermission(scope, siteId, "inventory:read");
    return null;
  } catch (error) {
    return denied(error);
  }
}

function authorizeManage(scope: Parameters<typeof assertSitePermission>[0], siteId: string) {
  try {
    assertSitePermission(scope, siteId, "work:manage");
    assertSitePermission(scope, siteId, "inventory:manage");
    return null;
  } catch (error) {
    return denied(error);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workOrderId: string }> },
) {
  const url = new URL(request.url);
  const parsed = scopeSchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const accessDenied = authorizeRead(auth.tenant.scope, parsed.data.siteId);
  if (accessDenied) return accessDenied;

  const { workOrderId } = await context.params;
  const workOrder = await requireWorkOrder(parsed.data.organizationId, parsed.data.siteId, workOrderId);
  if (!workOrder) return apiError(404, "WORK_ORDER_NOT_FOUND", "Work order not found in site scope");

  return apiData(
    await listWorkOrderReservations({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      workOrderId,
    }),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workOrderId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = reserveSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid stock reservation payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const accessDenied = authorizeManage(auth.tenant.scope, parsed.data.siteId);
  if (accessDenied) return accessDenied;

  const { workOrderId } = await context.params;
  try {
    return apiData(
      await reserveWorkOrderStock({
        ...parsed.data,
        workOrderId,
        actorId: auth.session.user.id,
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof StockReservationError) return reservationError(error);
    throw error;
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workOrderId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = releaseSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid stock reservation release payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const accessDenied = authorizeManage(auth.tenant.scope, parsed.data.siteId);
  if (accessDenied) return accessDenied;

  const { workOrderId } = await context.params;
  try {
    return apiData(
      await releaseWorkOrderStock({
        ...parsed.data,
        workOrderId,
        actorId: auth.session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof StockReservationError) return reservationError(error);
    throw error;
  }
}
