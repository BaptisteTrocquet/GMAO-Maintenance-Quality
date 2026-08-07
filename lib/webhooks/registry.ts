import { db } from "@/lib/db";
import {
  getWebhookSubscription,
  type WebhookSubscription,
} from "@/lib/webhooks/subscriptions";

export async function listAllWebhookSubscriptions(input?: { includeRevoked?: boolean }) {
  const createdLogs = await db.auditLog.findMany({
    where: { entityType: "WebhookSubscription", action: "CREATED" },
    select: { entityId: true },
    orderBy: { createdAt: "desc" },
  });
  const subscriptions = await Promise.all(
    createdLogs.map((log) => getWebhookSubscription(log.entityId)),
  );
  return subscriptions.filter(
    (subscription): subscription is WebhookSubscription =>
      Boolean(subscription && (input?.includeRevoked || !subscription.revokedAt)),
  );
}

export async function listScopedWebhookSubscriptions(input: {
  organizationId: string;
  siteId: string;
  includeRevoked?: boolean;
}) {
  const createdLogs = await db.auditLog.findMany({
    where: {
      entityType: "WebhookSubscription",
      action: "CREATED",
      afterJson: { contains: `"organizationId":"${input.organizationId}"` },
    },
    select: { entityId: true },
    orderBy: { createdAt: "desc" },
  });
  const subscriptions = await Promise.all(
    createdLogs.map((log) => getWebhookSubscription(log.entityId)),
  );
  return subscriptions.filter(
    (subscription): subscription is WebhookSubscription =>
      Boolean(
        subscription &&
          subscription.organizationId === input.organizationId &&
          subscription.siteId === input.siteId &&
          (input.includeRevoked || !subscription.revokedAt),
      ),
  );
}
