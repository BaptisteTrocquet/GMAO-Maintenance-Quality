import type { PublicMaintenanceRequestToken } from "@prisma/client";
import { db } from "@/lib/db";

const STATUS_VIEWS_PER_HOUR = 120;

export class PublicRequestStatusError extends Error {
  constructor(
    public readonly code: "TRACKING_NOT_FOUND" | "STATUS_RESULT_MISSING" | "RATE_LIMITED",
    message: string,
  ) {
    super(message);
    this.name = "PublicRequestStatusError";
  }
}

export async function getPublicMaintenanceRequestStatus(input: {
  token: PublicMaintenanceRequestToken;
  trackingId: string;
  origin?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const recentViews = await db.auditLog.count({
    where: {
      entityType: "PublicMaintenanceRequestToken",
      entityId: input.token.id,
      action: "PUBLIC_STATUS_VIEWED",
      createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
    },
  });
  if (recentViews >= STATUS_VIEWS_PER_HOUR) {
    throw new PublicRequestStatusError(
      "RATE_LIMITED",
      "This scoped token has reached its hourly request-status lookup limit",
    );
  }

  const submission = await db.publicMaintenanceRequestSubmission.findFirst({
    where: { id: input.trackingId, tokenId: input.token.id },
    select: { id: true, workOrderId: true, createdAt: true },
  });
  if (!submission) {
    throw new PublicRequestStatusError(
      "TRACKING_NOT_FOUND",
      "Tracking id was not found for this scoped token",
    );
  }

  const workOrder = await db.workOrder.findFirst({
    where: { id: submission.workOrderId, siteId: input.token.siteId },
    select: {
      number: true,
      status: true,
      requestedAt: true,
      plannedStart: true,
      dueAt: true,
      startedAt: true,
      completedAt: true,
      updatedAt: true,
    },
  });
  if (!workOrder) {
    throw new PublicRequestStatusError(
      "STATUS_RESULT_MISSING",
      "The tracked maintenance request is no longer available",
    );
  }

  await db.$transaction([
    db.publicMaintenanceRequestToken.update({
      where: { id: input.token.id },
      data: { lastUsedAt: now },
    }),
    db.auditLog.create({
      data: {
        actorId: null,
        entityType: "PublicMaintenanceRequestToken",
        entityId: input.token.id,
        action: "PUBLIC_STATUS_VIEWED",
        createdAt: now,
        afterJson: JSON.stringify({
          trackingId: submission.id,
          workOrderId: submission.workOrderId,
          origin: input.origin ?? null,
        }),
      },
    }),
  ]);

  return {
    trackingId: submission.id,
    workOrder: {
      number: workOrder.number,
      status: workOrder.status,
      requestedAt: workOrder.requestedAt,
      plannedStart: workOrder.plannedStart,
      dueAt: workOrder.dueAt,
      startedAt: workOrder.startedAt,
      completedAt: workOrder.completedAt,
      updatedAt: workOrder.updatedAt,
    },
  };
}
