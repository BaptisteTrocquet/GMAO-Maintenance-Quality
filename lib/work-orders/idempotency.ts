import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENT_REPLAY_HEADER = "x-opengmao-idempotent-replay";

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_TRANSACTION_ATTEMPTS = 4;

type WorkOrderMutationClient = Prisma.TransactionClient;

type IdempotencyMetadata<T = unknown> = {
  keyHash: string;
  requestHash: string;
  operation: string;
  response: T;
};

export type WorkOrderIdempotencyContext = {
  actorId: string;
  organizationId: string;
  siteId: string;
  workOrderId: string;
  keyHash: string;
  requestHash: string;
  operation: string;
};

export type WorkOrderMutationAudit = {
  action: string;
  beforeJson: string | null;
  after: unknown;
};

export class WorkOrderIdempotencyError extends Error {
  constructor(
    public readonly code: "INVALID_IDEMPOTENCY_KEY" | "IDEMPOTENCY_KEY_REUSED",
    message: string,
    public readonly status: 400 | 409,
  ) {
    super(message);
    this.name = "WorkOrderIdempotencyError";
  }
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

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function prepareWorkOrderIdempotency(input: {
  request: Request;
  actorId: string;
  organizationId: string;
  siteId: string;
  workOrderId: string;
  operation: string;
  payload: unknown;
}): WorkOrderIdempotencyContext | null {
  const key = input.request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim() ?? "";
  if (!key) return null;
  if (!KEY_PATTERN.test(key)) {
    throw new WorkOrderIdempotencyError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen",
      400,
    );
  }

  const keyHash = sha256(`${input.actorId}\u0000${input.workOrderId}\u0000${key}`);
  const requestHash = sha256(
    JSON.stringify(
      normalizeForHash({
        organizationId: input.organizationId,
        siteId: input.siteId,
        workOrderId: input.workOrderId,
        operation: input.operation,
        payload: input.payload,
      }),
    ),
  );

  return {
    actorId: input.actorId,
    organizationId: input.organizationId,
    siteId: input.siteId,
    workOrderId: input.workOrderId,
    keyHash,
    requestHash,
    operation: input.operation,
  };
}

function parseMetadata<T>(afterJson: string | null): IdempotencyMetadata<T> | null {
  if (!afterJson) return null;
  try {
    const parsed = JSON.parse(afterJson) as { idempotency?: unknown };
    const metadata = parsed.idempotency;
    if (!metadata || typeof metadata !== "object") return null;
    const value = metadata as Partial<IdempotencyMetadata<T>>;
    if (
      typeof value.keyHash !== "string" ||
      typeof value.requestHash !== "string" ||
      typeof value.operation !== "string" ||
      !("response" in value)
    ) {
      return null;
    }
    return value as IdempotencyMetadata<T>;
  } catch {
    return null;
  }
}

async function findReplay<T>(
  client: Pick<WorkOrderMutationClient, "$queryRaw"> | typeof db,
  context: WorkOrderIdempotencyContext,
): Promise<T | null> {
  const rows = await client.$queryRaw<Array<{ afterJson: string | null }>>`
    SELECT "afterJson"
    FROM "AuditLog"
    WHERE "entityType" = 'WorkOrder'
      AND "entityId" = ${context.workOrderId}
      AND "actorId" = ${context.actorId}
      AND "afterJson" IS NOT NULL
      AND ("afterJson"::jsonb -> 'idempotency' ->> 'keyHash') = ${context.keyHash}
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;
  const metadata = parseMetadata<T>(rows[0]?.afterJson ?? null);
  if (!metadata) return null;
  if (
    metadata.requestHash !== context.requestHash ||
    metadata.operation !== context.operation
  ) {
    throw new WorkOrderIdempotencyError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key was already used for a different work-order mutation",
      409,
    );
  }
  return metadata.response;
}

export async function lookupWorkOrderIdempotencyReplay<T>(
  context: WorkOrderIdempotencyContext | null,
): Promise<T | null> {
  if (!context) return null;
  return findReplay<T>(db, context);
}

function withReceipt<T>(
  after: unknown,
  context: WorkOrderIdempotencyContext,
  response: T,
) {
  const base =
    after && typeof after === "object" && !Array.isArray(after)
      ? { ...(after as Record<string, unknown>) }
      : { value: after };
  return {
    ...base,
    idempotency: {
      keyHash: context.keyHash,
      requestHash: context.requestHash,
      operation: context.operation,
      response,
    } satisfies IdempotencyMetadata<T>,
  };
}

function isRetryableTransactionError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || error.code === "P2002")
  );
}

export async function commitIdempotentWorkOrderMutation<T>(input: {
  context: WorkOrderIdempotencyContext;
  mutate: (client: WorkOrderMutationClient) => Promise<{
    value: T;
    audit: WorkOrderMutationAudit;
  }>;
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (transaction) => {
          // The hash is only a lock key; the full SHA-256 keyHash is still checked in the receipt.
          // Cast PostgreSQL's void lock result to text so Prisma can deserialize the query result.
          await transaction.$queryRaw<Array<{ lock: string }>>`
            SELECT pg_advisory_xact_lock(hashtextextended(${input.context.keyHash}, 0))::text AS "lock"
          `;

          const replay = await findReplay<T>(transaction, input.context);
          if (replay !== null) {
            return { value: replay, replayed: true };
          }

          const mutation = await input.mutate(transaction);
          await transaction.auditLog.create({
            data: {
              actorId: input.context.actorId,
              entityType: "WorkOrder",
              entityId: input.context.workOrderId,
              action: mutation.audit.action,
              beforeJson: mutation.audit.beforeJson,
              afterJson: JSON.stringify(
                withReceipt(mutation.audit.after, input.context, mutation.value),
              ),
            },
          });
          return { value: mutation.value, replayed: false };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  throw lastError;
}
