import {
  getIntegrationDeadLetterForReplay,
  listOpenIntegrationDeadLetters,
  markIntegrationDeadLetterReplayed,
} from "@/lib/integrations/dead-letter";
import { deliverWebhook, type WebhookEvent } from "@/lib/webhooks/delivery";
import {
  getWebhookSubscription,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@/lib/webhooks/subscriptions";

export class WebhookDeadLetterError extends Error {
  constructor(
    public readonly code:
      | "INVALID_WEBHOOK_DEAD_LETTER"
      | "WEBHOOK_SUBSCRIPTION_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "WebhookDeadLetterError";
  }
}

function isWebhookEventType(value: unknown): value is WebhookEventType {
  return (
    typeof value === "string" &&
    (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)
  );
}

function parseWebhookReplayPayload(payload: unknown): {
  subscriptionId: string;
  event: WebhookEvent;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WebhookDeadLetterError(
      "INVALID_WEBHOOK_DEAD_LETTER",
      "Webhook dead-letter payload is invalid",
    );
  }
  const value = payload as Record<string, unknown>;
  const event = value.event;
  if (
    typeof value.subscriptionId !== "string" ||
    !value.subscriptionId ||
    !event ||
    typeof event !== "object" ||
    Array.isArray(event)
  ) {
    throw new WebhookDeadLetterError(
      "INVALID_WEBHOOK_DEAD_LETTER",
      "Webhook dead-letter payload is invalid",
    );
  }
  const candidate = event as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !candidate.id ||
    !isWebhookEventType(candidate.type) ||
    typeof candidate.createdAt !== "string" ||
    !candidate.data ||
    typeof candidate.data !== "object" ||
    Array.isArray(candidate.data)
  ) {
    throw new WebhookDeadLetterError(
      "INVALID_WEBHOOK_DEAD_LETTER",
      "Webhook dead-letter event is invalid",
    );
  }
  return {
    subscriptionId: value.subscriptionId,
    event: {
      id: candidate.id,
      type: candidate.type,
      createdAt: candidate.createdAt,
      data: candidate.data as Record<string, unknown>,
    },
  };
}

export async function listWebhookDeadLetters(input: {
  organizationId: string;
  siteId: string;
  limit?: number;
}) {
  return listOpenIntegrationDeadLetters({
    organizationId: input.organizationId,
    siteId: input.siteId,
    channel: "webhook",
    limit: input.limit,
  });
}

export async function replayWebhookDeadLetter(input: {
  organizationId: string;
  siteId: string;
  deadLetterId: string;
  actorId: string;
  now?: Date;
}) {
  const deadLetter = await getIntegrationDeadLetterForReplay({
    id: input.deadLetterId,
    organizationId: input.organizationId,
    siteId: input.siteId,
    channel: "webhook",
  });
  const replay = parseWebhookReplayPayload(deadLetter.payload);
  const subscription = await getWebhookSubscription(replay.subscriptionId);
  if (
    !subscription ||
    subscription.revokedAt ||
    subscription.organizationId !== input.organizationId ||
    subscription.siteId !== input.siteId
  ) {
    throw new WebhookDeadLetterError(
      "WEBHOOK_SUBSCRIPTION_UNAVAILABLE",
      "Webhook subscription is unavailable in the requested tenant scope",
    );
  }

  await markIntegrationDeadLetterReplayed({
    id: input.deadLetterId,
    organizationId: input.organizationId,
    siteId: input.siteId,
    actorId: input.actorId,
    now: input.now,
  });

  return deliverWebhook({
    subscription,
    event: replay.event,
    attempt: 1,
    now: input.now,
  });
}
