import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const ENTITY_TYPE = "QualityEvidence";
const QUALITY_EVENT_ENTITY_TYPE = "QualityEvent";
const MAX_TRANSACTION_ATTEMPTS = 4;
export const MAX_QUALITY_EVIDENCE_BYTES = 25 * 1024 * 1024;

export const QUALITY_EVIDENCE_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
] as const;

export type QualityEvidenceCategory =
  | "CONTAINMENT"
  | "ROOT_CAUSE"
  | "CAPA_ACTION"
  | "EFFECTIVENESS"
  | "EIGHT_D"
  | "OTHER";

export type QualityEvidenceSnapshot = {
  evidenceId: string;
  eventId: string;
  organizationId: string;
  siteId: string;
  category: QualityEvidenceCategory;
  relatedActionId: string | null;
  fileName: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  note: string | null;
  active: boolean;
  uploadedById: string;
  uploadedAt: string;
  revokedById: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
};

type QualityEventReference = {
  organizationId: string;
  siteId: string;
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
};

export class QualityEvidenceError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "EVENT_CLOSED"
      | "EVIDENCE_NOT_FOUND"
      | "EVIDENCE_ALREADY_REVOKED"
      | "UNSUPPORTED_FILE_TYPE"
      | "FILE_TOO_LARGE"
      | "INVALID_FILE_METADATA"
      | "REVOKE_REASON_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "QualityEvidenceError";
  }
}

function parseEvent(value: string | null): QualityEventReference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualityEventReference>;
    if (
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "OPEN" &&
        parsed.status !== "CONTAINED" &&
        parsed.status !== "INVESTIGATING" &&
        parsed.status !== "CLOSED")
    ) {
      return null;
    }
    return parsed as QualityEventReference;
  } catch {
    return null;
  }
}

function parseEvidence(value: string | null): QualityEvidenceSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualityEvidenceSnapshot>;
    if (
      typeof parsed.evidenceId !== "string" ||
      typeof parsed.eventId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.category !== "CONTAINMENT" &&
        parsed.category !== "ROOT_CAUSE" &&
        parsed.category !== "CAPA_ACTION" &&
        parsed.category !== "EFFECTIVENESS" &&
        parsed.category !== "EIGHT_D" &&
        parsed.category !== "OTHER") ||
      !(parsed.relatedActionId === null || typeof parsed.relatedActionId === "string") ||
      typeof parsed.fileName !== "string" ||
      typeof parsed.storageKey !== "string" ||
      typeof parsed.mimeType !== "string" ||
      typeof parsed.sizeBytes !== "number" ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.uploadedById !== "string" ||
      typeof parsed.uploadedAt !== "string" ||
      !(parsed.revokedById === null || typeof parsed.revokedById === "string") ||
      !(parsed.revokedAt === null || typeof parsed.revokedAt === "string") ||
      !(parsed.revokeReason === null || typeof parsed.revokeReason === "string")
    ) {
      return null;
    }
    return parsed as QualityEvidenceSnapshot;
  } catch {
    return null;
  }
}

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

async function serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}

async function latestEvent(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  const log = await client.auditLog.findFirst({
    where: { entityType: QUALITY_EVENT_ENTITY_TYPE, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseEvent(log?.afterJson ?? null);
}

async function requireEvent(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  input: { organizationId: string; siteId: string; eventId: string; mutable?: boolean },
) {
  const event = await latestEvent(client, input.eventId);
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    throw new QualityEvidenceError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  if (input.mutable && event.status === "CLOSED") {
    throw new QualityEvidenceError("EVENT_CLOSED", "Closed quality events cannot change evidence");
  }
  return event;
}

function validateFile(input: { fileName: string; storageKey: string; mimeType: string; sizeBytes: number }) {
  if (!input.fileName.trim() || !input.storageKey.trim() || input.sizeBytes < 0) {
    throw new QualityEvidenceError("INVALID_FILE_METADATA", "Evidence requires valid file metadata");
  }
  if (!QUALITY_EVIDENCE_MIME_TYPES.includes(input.mimeType as (typeof QUALITY_EVIDENCE_MIME_TYPES)[number])) {
    throw new QualityEvidenceError(
      "UNSUPPORTED_FILE_TYPE",
      "Quality evidence must be PDF, JPEG, PNG, WebP or plain text",
    );
  }
  if (input.sizeBytes > MAX_QUALITY_EVIDENCE_BYTES) {
    throw new QualityEvidenceError(
      "FILE_TOO_LARGE",
      `Quality evidence is limited to ${MAX_QUALITY_EVIDENCE_BYTES} bytes per file`,
    );
  }
}

async function latestEvidence(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  evidenceId: string,
) {
  const log = await client.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: evidenceId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseEvidence(log?.afterJson ?? null);
}

export async function addQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  category: QualityEvidenceCategory;
  relatedActionId?: string | null;
  fileName: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  note?: string | null;
  actorId: string;
}) {
  validateFile(input);
  return serializable(async (tx) => {
    await requireEvent(tx, { ...input, mutable: true });
    const evidenceId = randomUUID();
    const snapshot: QualityEvidenceSnapshot = {
      evidenceId,
      eventId: input.eventId,
      organizationId: input.organizationId,
      siteId: input.siteId,
      category: input.category,
      relatedActionId: input.relatedActionId?.trim() || null,
      fileName: input.fileName.trim(),
      storageKey: input.storageKey.trim(),
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      note: input.note?.trim() || null,
      active: true,
      uploadedById: input.actorId,
      uploadedAt: new Date().toISOString(),
      revokedById: null,
      revokedAt: null,
      revokeReason: null,
    };
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: ENTITY_TYPE,
        entityId: evidenceId,
        action: "ADDED",
        afterJson: JSON.stringify(snapshot),
      },
    });
    return snapshot;
  });
}

export async function revokeQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  evidenceId: string;
  reason: string;
  actorId: string;
}) {
  const reason = input.reason.trim();
  if (!reason) {
    throw new QualityEvidenceError("REVOKE_REASON_REQUIRED", "Revoking evidence requires a reason");
  }
  return serializable(async (tx) => {
    await requireEvent(tx, { ...input, mutable: true });
    const previous = await latestEvidence(tx, input.evidenceId);
    if (
      !previous ||
      previous.organizationId !== input.organizationId ||
      previous.siteId !== input.siteId ||
      previous.eventId !== input.eventId
    ) {
      throw new QualityEvidenceError("EVIDENCE_NOT_FOUND", "Evidence not found in quality-event scope");
    }
    if (!previous.active) {
      throw new QualityEvidenceError("EVIDENCE_ALREADY_REVOKED", "Evidence is already revoked");
    }
    const now = new Date().toISOString();
    const snapshot: QualityEvidenceSnapshot = {
      ...previous,
      active: false,
      revokedById: input.actorId,
      revokedAt: now,
      revokeReason: reason,
    };
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: ENTITY_TYPE,
        entityId: input.evidenceId,
        action: "REVOKED",
        beforeJson: JSON.stringify(previous),
        afterJson: JSON.stringify(snapshot),
      },
    });
    return snapshot;
  });
}

export async function listQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  includeRevoked?: boolean;
}) {
  await requireEvent(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input);
  const logs = await db.auditLog.findMany({
    where: {
      entityType: ENTITY_TYPE,
      afterJson: { contains: `"eventId":"${input.eventId}"` },
    },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });
  const latest = new Map<string, QualityEvidenceSnapshot>();
  for (const log of logs) {
    const snapshot = parseEvidence(log.afterJson);
    if (
      snapshot &&
      snapshot.eventId === input.eventId &&
      snapshot.organizationId === input.organizationId &&
      snapshot.siteId === input.siteId
    ) {
      latest.set(log.entityId, snapshot);
    }
  }
  return [...latest.values()]
    .filter((evidence) => input.includeRevoked || evidence.active)
    .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
}
