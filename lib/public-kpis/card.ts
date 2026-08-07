import type { PublicMaintenanceRequestToken } from "@prisma/client";
import { db } from "@/lib/db";

const KPI_VIEWS_PER_HOUR = 120;
const KPI_VIEW_ACTION = "PUBLIC_KPI_VIEW";

export class PublicKpiCardError extends Error {
  constructor(public readonly code: "RATE_LIMITED", message: string) {
    super(message);
    this.name = "PublicKpiCardError";
  }
}

export async function getPublicKpiCard(input: {
  token: Pick<PublicMaintenanceRequestToken, "id" | "siteId">;
  origin?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const recentCount = await db.auditLog.count({
    where: {
      entityType: "PublicMaintenanceRequestToken",
      entityId: input.token.id,
      action: KPI_VIEW_ACTION,
      createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
    },
  });
  if (recentCount >= KPI_VIEWS_PER_HOUR) {
    throw new PublicKpiCardError(
      "RATE_LIMITED",
      "This scoped token has reached its hourly KPI-card lookup limit",
    );
  }

  const activeStatuses = ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] as const;
  const [openWorkOrders, overdueWorkOrders, inProgressWorkOrders, outOfServiceAssets] = await Promise.all([
    db.workOrder.count({
      where: { siteId: input.token.siteId, status: { in: [...activeStatuses] } },
    }),
    db.workOrder.count({
      where: {
        siteId: input.token.siteId,
        status: { in: [...activeStatuses] },
        dueAt: { lt: now },
      },
    }),
    db.workOrder.count({
      where: { siteId: input.token.siteId, status: "IN_PROGRESS" },
    }),
    db.asset.count({
      where: { siteId: input.token.siteId, status: "OUT_OF_SERVICE", archivedAt: null },
    }),
  ]);

  await db.auditLog.create({
    data: {
      actorId: null,
      entityType: "PublicMaintenanceRequestToken",
      entityId: input.token.id,
      action: KPI_VIEW_ACTION,
      afterJson: JSON.stringify({ origin: input.origin ?? null }),
      createdAt: now,
    },
  });

  return {
    openWorkOrders,
    overdueWorkOrders,
    inProgressWorkOrders,
    outOfServiceAssets,
    generatedAt: now,
  };
}
