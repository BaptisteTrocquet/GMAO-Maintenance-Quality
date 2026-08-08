import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getQualityEvent } from "@/lib/quality/events";
import { storage, type StorageAdapter } from "@/lib/storage";

const ENTITY_TYPE = "QualityEvidenceAttachment";
export const MAX_QUALITY_EVIDENCE_BYTES = 20 * 1024 * 1024;

export type QualityEvidenceSnapshot = {
  id: string;
  eventId: string;
  organizationId: string;
  siteId: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  checksumSha256: string;
  storageKey: string;
  kind: string;
  description: string | null;
  uploadedById: string;
  createdAt: string;
};

export class QualityEvidenceError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "EVENT_CLOSED"
      | "FILE_REQUIRED"
      | "FILE_TOO_LARGE"
      | "EVIDENCE_NOT_FOUND"
      | "FILE_INTEGRITY_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "QualityEvidenceError";
  }
}

function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

function parseSnapshot(value: string | null): QualityEvidenceSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualityEvidenceSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.eventId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.fileName !== "string" ||
      !(parsed.mimeType === null || typeof parsed.mimeType === "string") ||
      typeof parsed.sizeBytes !== "number" ||
      typeof parsed.checksumSha256 !== "string" ||
      typeof parsed.storageKey !== "string" ||
      typeof parsed.kind !== "string" ||
      !(parsed.description === null || typeof parsed.description === "string") ||
      typeof parsed.uploadedById !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return parsed as QualityEvidenceSnapshot;
  } catch {
    return null;
  }
}

function storageKeyFor(input: {
  organizationId: string;
  eventId: string;
  evidenceId: string;
  checksum: string;
}) {
  return `quality-evidence/${input.organizationId}/${input.eventId}/${input.evidenceId}/${input.checksum}`;
}

async function requireQualityEvent(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  writable?: boolean;
}) {
  const event = await getQualityEvent(input);
  if (!event) {
    throw new QualityEvidenceError(
      "QUALITY_EVENT_NOT_FOUND",
      "Quality event not found in site scope",
    );
  }
  if (input.writable && event.status === "CLOSED") {
    throw new QualityEvidenceError(
      "EVENT_CLOSED",
      "Closed quality events cannot receive new evidence",
    );
  }
  return event;
}

export async function attachQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
  fileName: string;
  mimeType?: string | null;
  kind?: string | null;
  description?: string | null;
  data: Uint8Array;
  adapter?: StorageAdapter;
}) {
  if (input.data.byteLength === 0) {
    throw new QualityEvidenceError("FILE_REQUIRED", "Quality evidence file cannot be empty");
  }
  if (input.data.byteLength > MAX_QUALITY_EVIDENCE_BYTES) {
    throw new QualityEvidenceError(
      "FILE_TOO_LARGE",
      `Quality evidence file cannot exceed ${MAX_QUALITY_EVIDENCE_BYTES} bytes`,
    );
  }
  await requireQualityEvent({ ...input, writable: true });

  const id = randomUUID();
  const checksumSha256 = sha256(input.data);
  const storageKey = storageKeyFor({
    organizationId: input.organizationId,
    eventId: input.eventId,
    evidenceId: id,
    checksum: checksumSha256,
  });
  const adapter = input.adapter ?? storage;
  await adapter.put(storageKey, input.data);

  const snapshot: QualityEvidenceSnapshot = {
    id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    siteId: input.siteId,
    fileName: input.fileName.trim() || "quality-evidence",
    mimeType: input.mimeType?.trim() || null,
    sizeBytes: input.data.byteLength,
    checksumSha256,
    storageKey,
    kind: input.kind?.trim() || "EVIDENCE",
    description: input.description?.trim() || null,
    uploadedById: input.actorId,
    createdAt: new Date().toISOString(),
  };

  try {
    await db.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: ENTITY_TYPE,
        entityId: id,
        action: "EVIDENCE_ATTACHED",
        afterJson: JSON.stringify(snapshot),
      },
    });
  } catch (error) {
    await adapter.delete(storageKey).catch(() => undefined);
    throw error;
  }

  return snapshot;
}

export async function listQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  await requireQualityEvent(input);
  const records = await db.auditLog.findMany({
    where: {
      entityType: ENTITY_TYPE,
      AND: [
        { afterJson: { contains: `"organizationId":"${input.organizationId}"` } },
        { afterJson: { contains: `"siteId":"${input.siteId}"` } },
        { afterJson: { contains: `"eventId":"${input.eventId}"` } },
      ],
    },
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: "desc" },
  });
  return records.flatMap((record) => {
    const evidence = parseSnapshot(record.afterJson);
    return evidence &&
      evidence.organizationId === input.organizationId &&
      evidence.siteId === input.siteId &&
      evidence.eventId === input.eventId
      ? [{ ...evidence, uploaderName: record.actor?.displayName ?? "System" }]
      : [];
  });
}

async function getQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  evidenceId: string;
}) {
  await requireQualityEvent(input);
  const record = await db.auditLog.findFirst({
    where: {
      entityType: ENTITY_TYPE,
      entityId: input.evidenceId,
    },
    select: { afterJson: true },
  });
  const evidence = parseSnapshot(record?.afterJson ?? null);
  if (
    !evidence ||
    evidence.organizationId !== input.organizationId ||
    evidence.siteId !== input.siteId ||
    evidence.eventId !== input.eventId
  ) {
    throw new QualityEvidenceError(
      "EVIDENCE_NOT_FOUND",
      "Quality evidence not found in site scope",
    );
  }
  return evidence;
}

export async function readQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  evidenceId: string;
  adapter?: StorageAdapter;
}) {
  const evidence = await getQualityEvidence(input);
  const adapter = input.adapter ?? storage;
  const data = await adapter.get(evidence.storageKey);
  if (sha256(data) !== evidence.checksumSha256) {
    throw new QualityEvidenceError(
      "FILE_INTEGRITY_FAILED",
      "Stored quality evidence does not match its recorded SHA-256 checksum",
    );
  }
  return { ...evidence, data };
}
