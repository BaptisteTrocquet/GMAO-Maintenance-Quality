import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  deriveWebhookSigningSecret,
  normalizeWebhookUrl,
  resolvePublicWebhookTarget,
} from "@/lib/webhooks/security";

export const WEBHOOK_EVENT_TYPES = ["work_order.created"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export type WebhookSubscription = {
  id: string;
  organizationId: string;
  siteId: string;
  name: string;
  url: string;
  eventTypes: WebhookEventType[];
  createdById: string;
  createdAt: Date;
  revokedAt: Date | null;
};

function isEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

function parseCreated(value: string | null, id: string, createdAt: Date): WebhookSubscription | null {
  if (!value) return null;
  try {
    const data = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof data.organizationId !== "string" ||
      typeof data.siteId !== "string" ||
      typeof data.name !== "string" ||
      typeof data.url !== "string" ||
      typeof data.createdById !== "string" ||
      !Array.isArray(data.eventTypes) ||
      !data.eventTypes.every(isEventType)
    ) {
      return null;
    }
    return {
      id,
      organizationId: data.organizationId,
      siteId: data.siteId,
      name: data.name,
      url: data.url,
      eventTypes: [...new Set(data.eventTypes)],
      createdById: data.createdById,
      createdAt,
      revokedAt: null,
    };
  } catch {
    return null;
  }
}

export async function getWebhookSubscription(subscriptionId: string) {
  const logs = await db.auditLog.findMany({
    where: { entityType: "WebhookSubscription", entityId: subscriptionId },
    orderBy: { createdAt: "asc" },
  });
  const createdLog = logs.find((log) => log.action === "CREATED");
  if (!createdLog) return null;
  const subscription = parseCreated(createdLog.afterJson, subscriptionId, createdLog.createdAt);
  if (!subscription) return null;
  const revoked = [...logs].reverse().find((log) => log.action === "REVOKED");
  if (revoked) subscription.revokedAt = revoked.createdAt;
  return subscription;
}

export async function listWebhookSubscriptions(input: {
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

export async function createWebhookSubscription(input: {
  organizationId: string;
  siteId: string;
  name: string;
  url: string;
  eventTypes: readonly WebhookEventType[];
  createdById: string;
}) {
  const active = await listWebhookSubscriptions({
    organizationId: input.organizationId,
    siteId: input.siteId,
  });
  if (active.length >= 20) {
    throw new Error("WEBHOOK_SUBSCRIPTION_LIMIT");
  }

  const normalizedUrl = normalizeWebhookUrl(input.url).toString();
  await resolvePublicWebhookTarget(normalizedUrl);
  const id = randomUUID();
  const eventTypes = [...new Set(input.eventTypes)];
  const createdAt = new Date();

  await db.auditLog.create({
    data: {
      actorId: input.createdById,
      entityType: "WebhookSubscription",
      entityId: id,
      action: "CREATED",
      afterJson: JSON.stringify({
        organizationId: input.organizationId,
        siteId: input.siteId,
        name: input.name,
        url: normalizedUrl,
        eventTypes,
        createdById: input.createdById,
      }),
      createdAt,
    },
  });

  return {
    subscription: {
      id,
      organizationId: input.organizationId,
      siteId: input.siteId,
      name: input.name,
      url: normalizedUrl,
      eventTypes,
      createdById: input.createdById,
      createdAt,
      revokedAt: null,
    } satisfies WebhookSubscription,
    signingSecret: deriveWebhookSigningSecret(id),
  };
}

export async function revokeWebhookSubscription(input: {
  subscriptionId: string;
  organizationId: string;
  siteId: string;
  actorId: string;
}) {
  const subscription = await getWebhookSubscription(input.subscriptionId);
  if (
    !subscription ||
    subscription.organizationId !== input.organizationId ||
    subscription.siteId !== input.siteId ||
    subscription.revokedAt
  ) {
    return false;
  }

  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: "WebhookSubscription",
      entityId: input.subscriptionId,
      action: "REVOKED",
      createdAt: new Date(),
    },
  });
  return true;
}
