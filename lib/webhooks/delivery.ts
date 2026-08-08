import { createHash, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { db } from "@/lib/db";
import { createRetryPolicy, type RetryOutcome } from "@/lib/integrations/retry-policy";
import {
  resolvePublicWebhookTarget,
  signWebhookPayload,
} from "@/lib/webhooks/security";
import {
  getWebhookSubscription,
  type WebhookEventType,
  type WebhookSubscription,
} from "@/lib/webhooks/subscriptions";

const DELIVERY_TIMEOUT_MS = 5_000;
const WEBHOOK_RETRY_POLICY = createRetryPolicy({
  maxAttempts: 5,
  delaysMs: [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000],
  maxDelayMs: 8 * 60 * 60_000,
  jitterRatio: 0,
});

export type WebhookEvent = {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  data: Record<string, unknown>;
};

type FailedDeliverySnapshot = {
  subscriptionId: string;
  event: WebhookEvent;
  attempt: number;
  nextAttemptAt: string | null;
  retryReason: string;
  statusCode: number | null;
  error: string | null;
};

export function webhookDeliveryId(subscriptionId: string, sourceEventId: string) {
  return createHash("sha256")
    .update(`${subscriptionId}:${sourceEventId}`)
    .digest("hex");
}

function retryAfterValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function postPinnedHttps(input: {
  subscription: WebhookSubscription;
  body: string;
  timestamp: string;
  signature: string;
}) {
  return new Promise<{ statusCode: number; retryAfter: string | null }>((resolve, reject) => {
    void resolvePublicWebhookTarget(input.subscription.url)
      .then((target) => {
        const request = httpsRequest(
          {
            protocol: "https:",
            hostname: target.address,
            port: target.url.port || 443,
            servername: target.url.hostname,
            method: "POST",
            path: `${target.url.pathname}${target.url.search}`,
            headers: {
              Host: target.url.host,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(input.body).toString(),
              "User-Agent": "OpenGMAO-Webhooks/1.0",
              "X-OpenGMAO-Event": JSON.parse(input.body).type,
              "X-OpenGMAO-Event-Id": JSON.parse(input.body).id,
              "X-OpenGMAO-Timestamp": input.timestamp,
              "X-OpenGMAO-Signature": `v1=${input.signature}`,
            },
          },
          (response) => {
            response.resume();
            resolve({
              statusCode: response.statusCode ?? 0,
              retryAfter: retryAfterValue(response.headers["retry-after"]),
            });
          },
        );
        request.setTimeout(DELIVERY_TIMEOUT_MS, () => {
          request.destroy(new Error("Webhook delivery timed out"));
        });
        request.once("error", reject);
        request.end(input.body);
      })
      .catch(reject);
  });
}

async function latestDeliveryState(deliveryId: string) {
  return db.auditLog.findFirst({
    where: { entityType: "WebhookDelivery", entityId: deliveryId },
    orderBy: { createdAt: "desc" },
  });
}

export async function deliverWebhook(input: {
  subscription: WebhookSubscription;
  event: WebhookEvent;
  attempt?: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const attempt = input.attempt ?? 1;
  const deliveryId = webhookDeliveryId(input.subscription.id, input.event.id);
  const body = JSON.stringify(input.event);
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const signature = signWebhookPayload({
    subscriptionId: input.subscription.id,
    timestamp,
    body,
  });

  let statusCode: number | null = null;
  let errorMessage: string | null = null;
  let outcome: RetryOutcome = { kind: "network" };
  try {
    const response = await postPinnedHttps({
      subscription: input.subscription,
      body,
      timestamp,
      signature,
    });
    statusCode = response.statusCode;
    if (statusCode >= 200 && statusCode < 300) {
      outcome = { kind: "success" };
    } else {
      errorMessage = `Webhook endpoint returned HTTP ${statusCode}`;
      outcome = { kind: "http", status: statusCode, retryAfter: response.retryAfter };
    }
  } catch {
    errorMessage = "Webhook delivery failed";
    outcome = { kind: "network" };
  }

  if (!errorMessage) {
    await db.auditLog.create({
      data: {
        actorId: null,
        entityType: "WebhookDelivery",
        entityId: deliveryId,
        action: "DELIVERED",
        afterJson: JSON.stringify({
          subscriptionId: input.subscription.id,
          eventId: input.event.id,
          eventType: input.event.type,
          attempt,
          statusCode,
        }),
        createdAt: now,
      },
    });
    return { delivered: true, deliveryId, attempt, statusCode };
  }

  const retryDecision = WEBHOOK_RETRY_POLICY.decide({
    attempt,
    idempotent: true,
    outcome,
    now,
  });
  const nextAttemptAt = retryDecision.retry ? retryDecision.nextAttemptAt : null;
  const snapshot: FailedDeliverySnapshot = {
    subscriptionId: input.subscription.id,
    event: input.event,
    attempt,
    nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
    retryReason: retryDecision.reason,
    statusCode,
    error: errorMessage,
  };
  await db.auditLog.create({
    data: {
      actorId: null,
      entityType: "WebhookDelivery",
      entityId: deliveryId,
      action: "FAILED",
      afterJson: JSON.stringify(snapshot),
      createdAt: now,
    },
  });
  return {
    delivered: false,
    deliveryId,
    attempt,
    statusCode,
    nextAttemptAt,
    retryReason: retryDecision.reason,
    error: errorMessage,
  };
}

export async function retryFailedWebhookDeliveries(input: {
  now?: Date;
  limit?: number;
}) {
  const now = input.now ?? new Date();
  const logs = await db.auditLog.findMany({
    where: { entityType: "WebhookDelivery", action: { in: ["FAILED", "DELIVERED"] } },
    orderBy: { createdAt: "desc" },
    take: Math.max((input.limit ?? 50) * 10, 100),
  });

  const latestByDelivery = new Map<string, (typeof logs)[number]>();
  for (const log of logs) {
    if (!latestByDelivery.has(log.entityId)) latestByDelivery.set(log.entityId, log);
  }

  const due = [...latestByDelivery.values()]
    .filter((log) => log.action === "FAILED")
    .slice(0, input.limit ?? 50);
  const results = [];

  for (const log of due) {
    if (!log.afterJson) continue;
    let snapshot: FailedDeliverySnapshot;
    try {
      snapshot = JSON.parse(log.afterJson) as FailedDeliverySnapshot;
    } catch {
      continue;
    }
    if (
      snapshot.attempt >= WEBHOOK_RETRY_POLICY.maxAttempts ||
      !snapshot.nextAttemptAt ||
      new Date(snapshot.nextAttemptAt).getTime() > now.getTime()
    ) {
      continue;
    }
    const subscription = await getWebhookSubscription(snapshot.subscriptionId);
    if (!subscription || subscription.revokedAt) continue;
    const state = await latestDeliveryState(log.entityId);
    if (state?.action === "DELIVERED") continue;

    results.push(
      await deliverWebhook({
        subscription,
        event: snapshot.event,
        attempt: snapshot.attempt + 1,
        now,
      }),
    );
  }
  return results;
}

export function newWebhookEvent(input: {
  type: WebhookEventType;
  data: Record<string, unknown>;
  createdAt?: Date;
}) {
  return {
    id: randomUUID(),
    type: input.type,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    data: input.data,
  } satisfies WebhookEvent;
}
