import { db } from "@/lib/db";
import { deliverWebhook, retryFailedWebhookDeliveries, webhookDeliveryId } from "@/lib/webhooks/delivery";
import { listAllWebhookSubscriptions } from "@/lib/webhooks/registry";
import type { WebhookEvent } from "@/lib/webhooks/delivery";

const EVENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function processWebhookQueue(input?: {
  now?: Date;
  eventLimit?: number;
  retryLimit?: number;
}) {
  const now = input?.now ?? new Date();
  const retries = await retryFailedWebhookDeliveries({
    now,
    limit: input?.retryLimit ?? 50,
  });

  const subscriptions = await listAllWebhookSubscriptions();
  if (subscriptions.length === 0) {
    return { retries, processedEvents: 0, deliveries: [] };
  }

  const sourceLogs = await db.auditLog.findMany({
    where: {
      entityType: "WorkOrder",
      action: { in: ["CREATED", "PUBLIC_REQUEST_CREATED"] },
      createdAt: { gte: new Date(now.getTime() - EVENT_LOOKBACK_MS) },
    },
    orderBy: { createdAt: "asc" },
    take: input?.eventLimit ?? 200,
  });

  const deliveries = [];
  for (const source of sourceLogs) {
    const workOrder = await db.workOrder.findUnique({
      where: { id: source.entityId },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        requestedAt: true,
        siteId: true,
        site: { select: { organizationId: true } },
        asset: { select: { code: true } },
      },
    });
    if (!workOrder) continue;

    const event: WebhookEvent = {
      id: source.id,
      type: "work_order.created",
      createdAt: source.createdAt.toISOString(),
      data: {
        workOrder: {
          id: workOrder.id,
          number: workOrder.number,
          title: workOrder.title,
          status: workOrder.status,
          requestedAt: workOrder.requestedAt.toISOString(),
          assetCode: workOrder.asset?.code ?? null,
        },
      },
    };

    for (const subscription of subscriptions) {
      if (
        subscription.organizationId !== workOrder.site.organizationId ||
        subscription.siteId !== workOrder.siteId ||
        subscription.createdAt > source.createdAt ||
        !subscription.eventTypes.includes(event.type)
      ) {
        continue;
      }

      const deliveryId = webhookDeliveryId(subscription.id, event.id);
      const latest = await db.auditLog.findFirst({
        where: { entityType: "WebhookDelivery", entityId: deliveryId },
        orderBy: { createdAt: "desc" },
      });
      if (latest) continue;

      deliveries.push(await deliverWebhook({ subscription, event, now }));
    }
  }

  return {
    retries,
    processedEvents: sourceLogs.length,
    deliveries,
  };
}
