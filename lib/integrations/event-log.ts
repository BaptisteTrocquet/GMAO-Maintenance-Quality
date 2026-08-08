import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const SOURCE_ID_MAX_LENGTH = 200;
const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "xapikey",
  "apikey",
  "password",
  "secret",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "token",
]);

export type IntegrationEventDirection = "INBOUND" | "OUTBOUND";

export type IntegrationEventEnvelope = {
  version: 1;
  id: string;
  organizationId: string;
  siteId: string | null;
  direction: IntegrationEventDirection;
  channel: string;
  eventType: string;
  sourceId: string;
  correlationId: string | null;
  causationId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  occurredAt: string;
  payloadHash: string;
  payload: Record<string, unknown>;
};

type EventLogClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "auditLog" | "organization" | "site"
>;

export class IntegrationEventLogError extends Error {
  constructor(
    public readonly code:
      | "INVALID_EVENT"
      | "UNSAFE_PAYLOAD"
      | "TENANT_SCOPE_MISMATCH"
      | "EVENT_IDENTITY_CONFLICT"
      | "EVENT_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "IntegrationEventLogError";
  }
}

function normalizeSensitiveKey(key: string) {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

function assertSafeValue(value: unknown, seen: Set<object>) {
  if (value === null || value === undefined) return;
  if (["string", "number", "boolean"].includes(typeof value)) return;
  if (typeof value !== "object") {
    throw new IntegrationEventLogError(
      "UNSAFE_PAYLOAD",
      "Integration-event payload must contain JSON-safe values only",
    );
  }
  if (seen.has(value as object)) {
    throw new IntegrationEventLogError("UNSAFE_PAYLOAD", "Integration-event payload cannot be cyclic");
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const child of value) assertSafeValue(child, seen);
  } else {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(normalizeSensitiveKey(key))) {
        throw new IntegrationEventLogError(
          "UNSAFE_PAYLOAD",
          "Integration-event payload cannot contain credential-like fields",
        );
      }
      assertSafeValue(child, seen);
    }
  }
  seen.delete(value as object);
}

function normalizeForHash(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeForHash(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(normalizeForHash(value));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function eventId(input: {
  organizationId: string;
  direction: IntegrationEventDirection;
  channel: string;
  sourceId: string;
}) {
  return sha256(
    `${input.organizationId}\u0000${input.direction}\u0000${input.channel}\u0000${input.sourceId}`,
  );
}

function validateIdentity(input: {
  organizationId: string;
  siteId?: string | null;
  direction: IntegrationEventDirection;
  channel: string;
  eventType: string;
  sourceId: string;
  correlationId?: string | null;
  causationId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
}) {
  if (!input.organizationId.trim()) {
    throw new IntegrationEventLogError("INVALID_EVENT", "organizationId is required");
  }
  if (input.direction !== "INBOUND" && input.direction !== "OUTBOUND") {
    throw new IntegrationEventLogError("INVALID_EVENT", "Integration-event direction is invalid");
  }
  if (!NAME_PATTERN.test(input.channel) || !NAME_PATTERN.test(input.eventType)) {
    throw new IntegrationEventLogError("INVALID_EVENT", "Integration-event channel or type is invalid");
  }
  if (!input.sourceId.trim() || input.sourceId.length > SOURCE_ID_MAX_LENGTH) {
    throw new IntegrationEventLogError("INVALID_EVENT", "Integration-event sourceId is invalid");
  }
  for (const [name, value] of [
    ["correlationId", input.correlationId],
    ["causationId", input.causationId],
    ["subjectType", input.subjectType],
    ["subjectId", input.subjectId],
  ] as const) {
    if (value && value.length > SOURCE_ID_MAX_LENGTH) {
      throw new IntegrationEventLogError("INVALID_EVENT", `${name} is too long`);
    }
  }
}

async function assertTenantScope(
  client: EventLogClient,
  input: { organizationId: string; siteId?: string | null },
) {
  if (input.siteId) {
    const site = await client.site.findFirst({
      where: {
        id: input.siteId,
        organizationId: input.organizationId,
        active: true,
        organization: { active: true },
      },
      select: { id: true },
    });
    if (!site) {
      throw new IntegrationEventLogError(
        "TENANT_SCOPE_MISMATCH",
        "Integration-event site does not belong to the active organization",
      );
    }
    return;
  }
  const organization = await client.organization.findFirst({
    where: { id: input.organizationId, active: true },
    select: { id: true },
  });
  if (!organization) {
    throw new IntegrationEventLogError(
      "TENANT_SCOPE_MISMATCH",
      "Integration-event organization is not active",
    );
  }
}

function parseEnvelope(afterJson: string | null): IntegrationEventEnvelope | null {
  if (!afterJson) return null;
  try {
    const value = JSON.parse(afterJson) as Partial<IntegrationEventEnvelope>;
    if (
      value.version !== 1 ||
      typeof value.id !== "string" ||
      typeof value.organizationId !== "string" ||
      !(value.siteId === null || typeof value.siteId === "string") ||
      (value.direction !== "INBOUND" && value.direction !== "OUTBOUND") ||
      typeof value.channel !== "string" ||
      typeof value.eventType !== "string" ||
      typeof value.sourceId !== "string" ||
      !(value.correlationId === null || typeof value.correlationId === "string") ||
      !(value.causationId === null || typeof value.causationId === "string") ||
      !(value.subjectType === null || typeof value.subjectType === "string") ||
      !(value.subjectId === null || typeof value.subjectId === "string") ||
      typeof value.occurredAt !== "string" ||
      typeof value.payloadHash !== "string" ||
      !value.payload ||
      typeof value.payload !== "object" ||
      Array.isArray(value.payload)
    ) {
      return null;
    }
    assertSafeValue(value.payload, new Set());
    return value as IntegrationEventEnvelope;
  } catch {
    return null;
  }
}

async function appendWithClient(
  client: EventLogClient,
  input: {
    organizationId: string;
    siteId?: string | null;
    direction: IntegrationEventDirection;
    channel: string;
    eventType: string;
    sourceId: string;
    correlationId?: string | null;
    causationId?: string | null;
    subjectType?: string | null;
    subjectId?: string | null;
    occurredAt?: Date;
    payload: Record<string, unknown>;
    createdAt?: Date;
  },
) {
  validateIdentity(input);
  assertSafeValue(input.payload, new Set());
  const payloadJson = stableJson(input.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new IntegrationEventLogError(
      "UNSAFE_PAYLOAD",
      `Integration-event payload cannot exceed ${MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  await assertTenantScope(client, input);

  const id = eventId(input);
  await client.$queryRaw<Array<{ lock: string }>>`
    SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text AS "lock"
  `;
  const existingRows = await client.$queryRaw<Array<{ afterJson: string | null }>>`
    SELECT "afterJson"
    FROM "AuditLog"
    WHERE "entityType" = 'IntegrationEvent'
      AND "entityId" = ${id}
      AND "action" = 'RECORDED'
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 1
  `;

  const occurredAt = input.occurredAt ?? input.createdAt ?? new Date();
  const envelope: IntegrationEventEnvelope = {
    version: 1,
    id,
    organizationId: input.organizationId,
    siteId: input.siteId ?? null,
    direction: input.direction,
    channel: input.channel,
    eventType: input.eventType,
    sourceId: input.sourceId,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    occurredAt: occurredAt.toISOString(),
    payloadHash: sha256(payloadJson),
    payload: JSON.parse(payloadJson) as Record<string, unknown>,
  };

  const existing = parseEnvelope(existingRows[0]?.afterJson ?? null);
  if (existing) {
    const comparable = (value: IntegrationEventEnvelope) => ({
      organizationId: value.organizationId,
      siteId: value.siteId,
      direction: value.direction,
      channel: value.channel,
      eventType: value.eventType,
      sourceId: value.sourceId,
      correlationId: value.correlationId,
      causationId: value.causationId,
      subjectType: value.subjectType,
      subjectId: value.subjectId,
      occurredAt: value.occurredAt,
      payloadHash: value.payloadHash,
    });
    if (stableJson(comparable(existing)) !== stableJson(comparable(envelope))) {
      throw new IntegrationEventLogError(
        "EVENT_IDENTITY_CONFLICT",
        "Integration-event source identity was already used for different content",
      );
    }
    return { event: existing, replayed: true };
  }

  await client.auditLog.create({
    data: {
      actorId: null,
      entityType: "IntegrationEvent",
      entityId: id,
      action: "RECORDED",
      afterJson: JSON.stringify(envelope),
      createdAt: input.createdAt ?? occurredAt,
    },
  });
  return { event: envelope, replayed: false };
}

export async function recordIntegrationEvent(input: Parameters<typeof appendWithClient>[1]) {
  return db.$transaction((tx) => appendWithClient(tx, input));
}

export async function recordIntegrationEventInTransaction(
  tx: Prisma.TransactionClient,
  input: Parameters<typeof appendWithClient>[1],
) {
  return appendWithClient(tx, input);
}

export async function listPendingIntegrationEvents(input: {
  direction: IntegrationEventDirection;
  channel: string;
  eventType?: string;
  limit?: number;
}) {
  if ((input.direction !== "INBOUND" && input.direction !== "OUTBOUND") || !NAME_PATTERN.test(input.channel)) {
    throw new IntegrationEventLogError("INVALID_EVENT", "Pending-event filter is invalid");
  }
  if (input.eventType && !NAME_PATTERN.test(input.eventType)) {
    throw new IntegrationEventLogError("INVALID_EVENT", "Pending-event type is invalid");
  }
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  const rows = await db.$queryRaw<Array<{ afterJson: string | null }>>`
    WITH latest AS (
      SELECT DISTINCT ON ("entityId")
        "entityId", "action", "afterJson", "createdAt", "id"
      FROM "AuditLog"
      WHERE "entityType" = 'IntegrationEvent'
      ORDER BY "entityId", "createdAt" DESC, "id" DESC
    )
    SELECT "afterJson"
    FROM latest
    WHERE "action" = 'RECORDED'
      AND ("afterJson"::jsonb ->> 'direction') = ${input.direction}
      AND ("afterJson"::jsonb ->> 'channel') = ${input.channel}
      AND (${input.eventType ?? null}::text IS NULL OR ("afterJson"::jsonb ->> 'eventType') = ${input.eventType ?? null})
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${limit}
  `;
  return rows.flatMap((row) => {
    const event = parseEnvelope(row.afterJson);
    return event ? [event] : [];
  });
}

export async function markIntegrationEventProcessed(input: {
  event: IntegrationEventEnvelope;
  processedAt?: Date;
}) {
  const processedAt = input.processedAt ?? new Date();
  return db.$transaction(async (tx) => {
    await assertTenantScope(tx, input.event);
    await tx.$queryRaw<Array<{ lock: string }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${input.event.id}, 0))::text AS "lock"
    `;
    const latest = await tx.auditLog.findFirst({
      where: { entityType: "IntegrationEvent", entityId: input.event.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!latest) {
      throw new IntegrationEventLogError("EVENT_NOT_FOUND", "Integration event was not found");
    }
    if (latest.action === "PROCESSED") return { processed: false };
    if (latest.action !== "RECORDED") {
      throw new IntegrationEventLogError("EVENT_NOT_FOUND", "Integration event is not processable");
    }
    const recorded = parseEnvelope(latest.afterJson);
    if (!recorded || recorded.id !== input.event.id) {
      throw new IntegrationEventLogError("EVENT_NOT_FOUND", "Integration event record is invalid");
    }
    await tx.auditLog.create({
      data: {
        actorId: null,
        entityType: "IntegrationEvent",
        entityId: input.event.id,
        action: "PROCESSED",
        afterJson: JSON.stringify({
          organizationId: recorded.organizationId,
          siteId: recorded.siteId,
          direction: recorded.direction,
          channel: recorded.channel,
          eventType: recorded.eventType,
          sourceId: recorded.sourceId,
          payloadHash: recorded.payloadHash,
        }),
        createdAt: processedAt,
      },
    });
    return { processed: true };
  });
}
