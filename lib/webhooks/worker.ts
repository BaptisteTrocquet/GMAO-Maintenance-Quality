import { db } from "@/lib/db";
import {
  listPendingIntegrationEvents,
  markIntegrationEventProcessed,
} from "@/lib/integrations/event-log";
import {
  deliverWebhook,
  retryFailedWebhookDeliveries,
  webhookDeliveryId,
  type WebhookEvent,
} from "@/lib/webhooks/delivery";
import { listAllWebhookSubscriptions } from "@/lib/webhooks/registry";
import type { WebhookEventType } from "@/lib/webhooks/subscriptions";

function isWebhookEventType(value: string): value is WebhookEventType {
  return value === "work_order.created";
}

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
  const sourceEvents = await listPendingIntegrationEvents({
    direction: "OUTBOUND",
    channel: "webhook",
    limit: input?.eventLimit ?? 200,
  });

  const deliveries = [];
  for (const source of sourceEvents) {
    if (!source.siteId || !isWebhookEventType(source.eventType)) {
      await markIntegrationEventProcessed({ event: source, processedAt: now });
      continue;
    }

    const event: WebhookEvent = {
      id: source.id,
      type: source.eventType,
      createdAt: source.occurredAt,
      data: source.payload,
    };
    const occurredAt = new Date(source.occurredAt);

    for (const subscription of subscriptions) {
      if (
        subscription.organizationId !== source.organizationId ||
        subscription.siteId !== source.siteId ||
        subscription.createdAt > occurredAt ||
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

    await markIntegrationEventProcessed({ event: source, processedAt: now });
  }

  return {
    retries,
    processedEvents: sourceEvents.length,
    deliveries,
  };
}
