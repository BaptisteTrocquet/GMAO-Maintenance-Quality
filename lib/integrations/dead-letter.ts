import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "password",
  "secret",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "token",
]);

export type IntegrationDeadLetterReason =
  | "attempt_limit"
  | "non_idempotent"
  | "permanent"
  | "http_not_retryable";

export type IntegrationDeadLetterMetadata = {
  id: string;
  organizationId: string;
  siteId: string | null;
  channel: string;
  sourceId: string;
  reason: string;
  attempts: number;
  statusCode: number | null;
  errorCode: string | null;
  replayCount: number;
  lastReplayedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export class IntegrationDeadLetterError extends Error {
  constructor(
    public readonly code:
      | "INVALID_DEAD_LETTER"
      | "UNSAFE_PAYLOAD"
      | "TENANT_SCOPE_MISMATCH"
      | "DEAD_LETTER_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "IntegrationDeadLetterError";
  }
}

function normalizeSensitiveKey(key: string) {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

function assertSafePayloadValue(value: unknown, seen: Set<object>) {
  if (value === null || value === undefined) return;
  if (["string", "number", "boolean"].includes(typeof value)) return;
  if (typeof value !== "object") {
    throw new IntegrationDeadLetterError(
      "UNSAFE_PAYLOAD",
      "Dead-letter payload must contain JSON-safe values only",
    );
  }
  if (seen.has(value as object)) {
    throw new IntegrationDeadLetterError("UNSAFE_PAYLOAD", "Dead-letter payload cannot be cyclic");
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const child of value) assertSafePayloadValue(child, seen);
  } else {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(normalizeSensitiveKey(key))) {
        throw new IntegrationDeadLetterError(
          "UNSAFE_PAYLOAD",
          "Dead-letter payload cannot contain credential-like fields",
        );
      }
      assertSafePayloadValue(child, seen);
    }
  }
  seen.delete(value as object);
}

function serializeSafePayload(payload: unknown) {
  assertSafePayloadValue(payload, new Set());
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new IntegrationDeadLetterError(
      "UNSAFE_PAYLOAD",
      "Dead-letter payload must be JSON serializable",
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new IntegrationDeadLetterError(
      "UNSAFE_PAYLOAD",
      `Dead-letter payload cannot exceed ${MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  return serialized;
}

function validateIdentity(input: {
  organizationId: string;
  siteId?: string | null;
  channel: string;
  sourceId: string;
  attempts?: number;
}) {
  if (!input.organizationId.trim()) {
    throw new IntegrationDeadLetterError("INVALID_DEAD_LETTER", "organizationId is required");
  }
  if (!CHANNEL_PATTERN.test(input.channel)) {
    throw new IntegrationDeadLetterError("INVALID_DEAD_LETTER", "Dead-letter channel is invalid");
  }
  if (!input.sourceId.trim() || input.sourceId.length > 200) {
    throw new IntegrationDeadLetterError("INVALID_DEAD_LETTER", "Dead-letter sourceId is invalid");
  }
  if (input.attempts !== undefined && (!Number.isInteger(input.attempts) || input.attempts < 1)) {
    throw new IntegrationDeadLetterError(
      "INVALID_DEAD_LETTER",
      "Dead-letter attempts must be a positive integer",
    );
  }
}

async function assertTenantScope(
  client: Prisma.TransactionClient | typeof db,
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
      throw new IntegrationDeadLetterError(
        "TENANT_SCOPE_MISMATCH",
        "Dead-letter site does not belong to the active organization",
      );
    }
    return;
  }

  const organization = await client.organization.findFirst({
    where: { id: input.organizationId, active: true },
    select: { id: true },
  });
  if (!organization) {
    throw new IntegrationDeadLetterError(
      "TENANT_SCOPE_MISMATCH",
      "Dead-letter organization is not active",
    );
  }
}

function metadata(record: IntegrationDeadLetterMetadata): IntegrationDeadLetterMetadata {
  return {
    id: record.id,
    organizationId: record.organizationId,
    siteId: record.siteId,
    channel: record.channel,
    sourceId: record.sourceId,
    reason: record.reason,
    attempts: record.attempts,
    statusCode: record.statusCode,
    errorCode: record.errorCode,
    replayCount: record.replayCount,
    lastReplayedAt: record.lastReplayedAt,
    resolvedAt: record.resolvedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function recordIntegrationDeadLetter(input: {
  organizationId: string;
  siteId?: string | null;
  channel: string;
  sourceId: string;
  reason: IntegrationDeadLetterReason | string;
  attempts: number;
  statusCode?: number | null;
  errorCode?: string | null;
  payload: unknown;
  now?: Date;
}) {
  validateIdentity(input);
  const payloadJson = serializeSafePayload(input.payload);
  const now = input.now ?? new Date();

  return db.$transaction(async (tx) => {
    await assertTenantScope(tx, input);
    const record = await tx.integrationDeadLetter.upsert({
      where: {
        organizationId_channel_sourceId: {
          organizationId: input.organizationId,
          channel: input.channel,
          sourceId: input.sourceId,
        },
      },
      create: {
        organizationId: input.organizationId,
        siteId: input.siteId ?? null,
        channel: input.channel,
        sourceId: input.sourceId,
        reason: input.reason,
        attempts: input.attempts,
        statusCode: input.statusCode ?? null,
        errorCode: input.errorCode ?? null,
        payloadJson,
        createdAt: now,
      },
      update: {
        siteId: input.siteId ?? null,
        reason: input.reason,
        attempts: input.attempts,
        statusCode: input.statusCode ?? null,
        errorCode: input.errorCode ?? null,
        payloadJson,
        resolvedAt: null,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: null,
        entityType: "IntegrationDeadLetter",
        entityId: record.id,
        action: "DEAD_LETTERED",
        afterJson: JSON.stringify({
          organizationId: record.organizationId,
          siteId: record.siteId,
          channel: record.channel,
          sourceId: record.sourceId,
          reason: record.reason,
          attempts: record.attempts,
          statusCode: record.statusCode,
          errorCode: record.errorCode,
        }),
        createdAt: now,
      },
    });
    return metadata(record);
  });
}

export async function listOpenIntegrationDeadLetters(input: {
  organizationId: string;
  siteId?: string | null;
  channel?: string;
  limit?: number;
}) {
  validateIdentity({
    organizationId: input.organizationId,
    siteId: input.siteId,
    channel: input.channel ?? "all",
    sourceId: "list",
  });
  await assertTenantScope(db, input);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const records = await db.integrationDeadLetter.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.siteId === undefined ? {} : { siteId: input.siteId }),
      ...(input.channel ? { channel: input.channel } : {}),
      resolvedAt: null,
    },
    select: {
      id: true,
      organizationId: true,
      siteId: true,
      channel: true,
      sourceId: true,
      reason: true,
      attempts: true,
      statusCode: true,
      errorCode: true,
      replayCount: true,
      lastReplayedAt: true,
      resolvedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return records.map(metadata);
}

export async function getIntegrationDeadLetterForReplay(input: {
  id: string;
  organizationId: string;
  siteId?: string | null;
  channel: string;
}) {
  validateIdentity({ ...input, sourceId: input.id });
  await assertTenantScope(db, input);
  const record = await db.integrationDeadLetter.findFirst({
    where: {
      id: input.id,
      organizationId: input.organizationId,
      ...(input.siteId === undefined ? {} : { siteId: input.siteId }),
      channel: input.channel,
      resolvedAt: null,
    },
  });
  if (!record) {
    throw new IntegrationDeadLetterError(
      "DEAD_LETTER_NOT_FOUND",
      "Open dead letter was not found in the requested tenant scope",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(record.payloadJson) as unknown;
  } catch {
    throw new IntegrationDeadLetterError("UNSAFE_PAYLOAD", "Dead-letter payload is corrupted");
  }
  assertSafePayloadValue(payload, new Set());
  return { metadata: metadata(record), payload };
}

export async function markIntegrationDeadLetterReplayed(input: {
  id: string;
  organizationId: string;
  siteId?: string | null;
  actorId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    await assertTenantScope(tx, input);
    const record = await tx.integrationDeadLetter.findFirst({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        ...(input.siteId === undefined ? {} : { siteId: input.siteId }),
        resolvedAt: null,
      },
    });
    if (!record) {
      throw new IntegrationDeadLetterError(
        "DEAD_LETTER_NOT_FOUND",
        "Open dead letter was not found in the requested tenant scope",
      );
    }
    const updated = await tx.integrationDeadLetter.update({
      where: { id: record.id },
      data: { replayCount: { increment: 1 }, lastReplayedAt: now },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: "IntegrationDeadLetter",
        entityId: record.id,
        action: "REPLAYED",
        afterJson: JSON.stringify({
          organizationId: record.organizationId,
          siteId: record.siteId,
          channel: record.channel,
          sourceId: record.sourceId,
          replayCount: updated.replayCount,
        }),
        createdAt: now,
      },
    });
    return metadata(updated);
  });
}

export async function resolveIntegrationDeadLetter(input: {
  organizationId: string;
  channel: string;
  sourceId: string;
  actorId?: string | null;
  now?: Date;
}) {
  validateIdentity({ ...input });
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    const record = await tx.integrationDeadLetter.findFirst({
      where: {
        organizationId: input.organizationId,
        channel: input.channel,
        sourceId: input.sourceId,
        resolvedAt: null,
      },
    });
    if (!record) return null;
    const resolved = await tx.integrationDeadLetter.update({
      where: { id: record.id },
      data: { resolvedAt: now },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        entityType: "IntegrationDeadLetter",
        entityId: record.id,
        action: "RESOLVED",
        afterJson: JSON.stringify({
          organizationId: record.organizationId,
          siteId: record.siteId,
          channel: record.channel,
          sourceId: record.sourceId,
          replayCount: record.replayCount,
        }),
        createdAt: now,
      },
    });
    return metadata(resolved);
  });
}
