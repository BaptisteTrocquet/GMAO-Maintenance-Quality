import { db } from "@/lib/db";
import { apiData, apiError } from "@/lib/api-response";
import { assertSitePermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { recordIntegrationEventInTransaction } from "@/lib/integrations/event-log";
import { z } from "zod";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  assetId: z.string().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["CORRECTIVE", "PREVENTIVE", "INSPECTION", "IMPROVEMENT", "SAFETY", "OTHER"]),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
});

async function nextNumber() {
  const count = await db.workOrder.count();
  return `WO-${String(count + 1).padStart(6, "0")}`;
}

async function findActiveSite(organizationId: string, siteId: string) {
  return db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
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

  try {
    assertSitePermission(auth.tenant.scope, siteId, "work:read");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  if (!(await findActiveSite(organizationId, siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Site not found");
  }

  return apiData(
    await db.workOrder.findMany({
      where: { siteId },
      include: { site: true, asset: true, assignee: true },
      orderBy: { requestedAt: "desc" },
    }),
  );
}

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid work order payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "work:create");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  if (!(await findActiveSite(parsed.data.organizationId, parsed.data.siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Site not found");
  }

  let assetCode: string | null = null;
  if (parsed.data.assetId) {
    const asset = await db.asset.findFirst({
      where: {
        id: parsed.data.assetId,
        siteId: parsed.data.siteId,
        archivedAt: null,
      },
      select: { id: true, code: true },
    });
    if (!asset) return apiError(404, "ASSET_NOT_FOUND", "Asset not found in site scope");
    assetCode = asset.code;
  }

  const number = await nextNumber();
  const created = await db.$transaction(async (tx) => {
    const workOrder = await tx.workOrder.create({
      data: {
        siteId: parsed.data.siteId,
        assetId: parsed.data.assetId,
        requesterId: auth.session.user.id,
        number,
        title: parsed.data.title,
        description: parsed.data.description,
        type: parsed.data.type,
        priority: parsed.data.priority,
      },
    });

    const audit = await tx.auditLog.create({
      data: {
        actorId: auth.session.user.id,
        entityType: "WorkOrder",
        entityId: workOrder.id,
        action: "CREATED",
        afterJson: JSON.stringify(workOrder),
      },
    });

    await recordIntegrationEventInTransaction(tx, {
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      direction: "OUTBOUND",
      channel: "webhook",
      eventType: "work_order.created",
      sourceId: audit.id,
      correlationId: workOrder.id,
      subjectType: "WorkOrder",
      subjectId: workOrder.id,
      occurredAt: workOrder.requestedAt,
      payload: {
        workOrder: {
          id: workOrder.id,
          number: workOrder.number,
          title: workOrder.title,
          status: workOrder.status,
          requestedAt: workOrder.requestedAt.toISOString(),
          assetCode,
        },
      },
    });
    return workOrder;
  });

  return apiData(created, { status: 201 });
}
