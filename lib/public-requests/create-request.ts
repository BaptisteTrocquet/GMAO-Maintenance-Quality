import { randomBytes } from "node:crypto";
import type { PublicMaintenanceRequestToken } from "@prisma/client";
import { db } from "@/lib/db";
import { recordIntegrationEventInTransaction } from "@/lib/integrations/event-log";

const REQUESTS_PER_HOUR = 30;

export class PublicMaintenanceRequestError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_FOUND" | "RATE_LIMITED" | "IDEMPOTENT_RESULT_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "PublicMaintenanceRequestError";
  }
}

function nextPublicWorkOrderNumber() {
  return `WO-P-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

async function existingResult(tokenId: string, idempotencyKey: string) {
  const submission = await db.publicMaintenanceRequestSubmission.findUnique({
    where: { tokenId_idempotencyKey: { tokenId, idempotencyKey } },
  });
  if (!submission) return null;

  const workOrder = await db.workOrder.findUnique({
    where: { id: submission.workOrderId },
    select: { id: true, number: true, status: true, requestedAt: true },
  });
  if (!workOrder) {
    throw new PublicMaintenanceRequestError(
      "IDEMPOTENT_RESULT_MISSING",
      "The original public request result is no longer available",
    );
  }
  return { workOrder, trackingId: submission.id, idempotent: true };
}

export async function createPublicMaintenanceRequest(input: {
  token: PublicMaintenanceRequestToken;
  idempotencyKey: string;
  title: string;
  description?: string | null;
  assetCode?: string | null;
  requesterName?: string | null;
  requesterEmail?: string | null;
  requesterRef?: string | null;
  origin?: string | null;
  now?: Date;
}) {
  const duplicate = await existingResult(input.token.id, input.idempotencyKey);
  if (duplicate) return duplicate;

  const now = input.now ?? new Date();
  const recentCount = await db.publicMaintenanceRequestSubmission.count({
    where: {
      tokenId: input.token.id,
      createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
    },
  });
  if (recentCount >= REQUESTS_PER_HOUR) {
    throw new PublicMaintenanceRequestError(
      "RATE_LIMITED",
      "This public maintenance request token has reached its hourly request limit",
    );
  }

  let assetId: string | null = null;
  if (input.assetCode) {
    const asset = await db.asset.findFirst({
      where: { siteId: input.token.siteId, code: input.assetCode, archivedAt: null },
      select: { id: true },
    });
    if (!asset) {
      throw new PublicMaintenanceRequestError(
        "ASSET_NOT_FOUND",
        "Asset code was not found in the public request site",
      );
    }
    assetId = asset.id;
  }

  try {
    return await db.$transaction(async (tx) => {
      const transactionDuplicate = await tx.publicMaintenanceRequestSubmission.findUnique({
        where: {
          tokenId_idempotencyKey: {
            tokenId: input.token.id,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (transactionDuplicate) {
        const workOrder = await tx.workOrder.findUnique({
          where: { id: transactionDuplicate.workOrderId },
          select: { id: true, number: true, status: true, requestedAt: true },
        });
        if (!workOrder) {
          throw new PublicMaintenanceRequestError(
            "IDEMPOTENT_RESULT_MISSING",
            "The original public request result is no longer available",
          );
        }
        return { workOrder, trackingId: transactionDuplicate.id, idempotent: true };
      }

      const workOrder = await tx.workOrder.create({
        data: {
          number: nextPublicWorkOrderNumber(),
          siteId: input.token.siteId,
          assetId,
          requesterId: null,
          title: input.title,
          description: input.description ?? null,
          type: "CORRECTIVE",
          status: "REQUESTED",
          priority: "NORMAL",
        },
        select: { id: true, number: true, title: true, status: true, requestedAt: true },
      });

      const submission = await tx.publicMaintenanceRequestSubmission.create({
        data: {
          tokenId: input.token.id,
          workOrderId: workOrder.id,
          idempotencyKey: input.idempotencyKey,
          requesterName: input.requesterName ?? null,
          requesterEmail: input.requesterEmail ?? null,
          requesterRef: input.requesterRef ?? null,
          origin: input.origin ?? null,
        },
        select: { id: true },
      });

      await tx.publicMaintenanceRequestToken.update({
        where: { id: input.token.id },
        data: { lastUsedAt: now },
      });

      const audit = await tx.auditLog.create({
        data: {
          actorId: null,
          entityType: "WorkOrder",
          entityId: workOrder.id,
          action: "PUBLIC_REQUEST_CREATED",
          afterJson: JSON.stringify({
            tokenId: input.token.id,
            submissionId: submission.id,
            mode: input.token.mode,
            assetCode: input.assetCode ?? null,
            requesterName: input.requesterName ?? null,
            requesterEmail: input.requesterEmail ?? null,
            requesterRef: input.requesterRef ?? null,
            origin: input.origin ?? null,
            idempotencyKey: input.idempotencyKey,
          }),
        },
      });

      await recordIntegrationEventInTransaction(tx, {
        organizationId: input.token.organizationId,
        siteId: input.token.siteId,
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
            assetCode: input.assetCode ?? null,
          },
        },
      });

      return { workOrder, trackingId: submission.id, idempotent: false };
    });
  } catch (error) {
    if (error instanceof PublicMaintenanceRequestError) throw error;
    const racedDuplicate = await existingResult(input.token.id, input.idempotencyKey);
    if (racedDuplicate) return racedDuplicate;
    throw error;
  }
}
