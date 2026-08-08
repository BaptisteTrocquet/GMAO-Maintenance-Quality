import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getQualityEvent } from "@/lib/quality/events";
import { storage, type StorageAdapter } from "@/lib/storage";

const EVIDENCE_ENTITY = "QualityEvidenceAttachment";
export const MAX_QUALITY_EVIDENCE_BYTES = 20 * 1024 * 1024;

export type QualityEvidencePhase =
  | "EVENT"
  | "CONTAINMENT"
  | "ROOT_CAUSE"
  | "CAPA"
  | "EFFECTIVENESS"
  | "EIGHT_D";

export type QualityEvidenceKind = "DOCUMENT" | "PHOTO" | "RECORD";

export type QualityEvidenceSnapshot = {
  id: string;
  eventId: string;
  organizationId: string;
  siteId: string;
  phase: QualityEvidencePhase;
  kind: QualityEvidenceKind;
  fileName: string;
  storageKey: string;
  mimeType: string | null;
  sizeBytes: number;
  checksum: string;
  description: string | null;
  createdById: string;
  createdAt: string;
  removedAt: string | null;
  removedById: string | null;
};

export class QualityEvidenceError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "EVENT_CLOSED"
      | "INVALID_EVIDENCE_DATA"
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

function parseEvidence(value: string | null): QualityEvidenceSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualityEvidenceSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.eventId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.phase !== "EVENT" &&
        parsed.phase !== "CONTAINMENT" &&
        parsed.phase !== "ROOT_CAUSE" &&
        parsed.phase !== "CAPA" &&
        parsed.phase !== "EFFECTIVENESS" &&
        parsed.phase !== "EIGHT_D") ||
      (parsed.kind !== "DOCUMENT" && parsed.kind !== "PHOTO" && parsed.kind !== "RECORD") ||
      typeof parsed.fileName !== "string" ||
      typeof parsed.storageKey !== "string" ||
      !(parsed.mimeType === null || typeof parsed.mimeType === "string") ||
      typeof parsed.sizeBytes !== "number" ||
      typeof parsed.checksum !== "string" ||
      !(parsed.description === null || typeof parsed.description === "string") ||
      typeof parsed.createdById !== "string" ||
      typeof parsed.createdAt !== "string" ||
      !(parsed.removedAt === null || typeof parsed.removedAt === "string") ||
      !(parsed.removedById === null || typeof parsed.removedById === "string")
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
  const qualityEvent = await getQualityEvent({
    organizationId: input.organizationId,
    siteId: input.siteId,
    eventId: input.eventId,
  });
  if (!qualityEvent) {
    throw new QualityEvidenceError(
      "QUALITY_EVENT_NOT_FOUND",
      "Quality event not found in site scope",
    );
  }
  if (input.writable && qualityEvent.status === "CLOSED") {
    throw new QualityEvidenceError(
      "EVENT_CLOSED",
      "Evidence cannot be changed after the quality event is closed",
    );
  }
  return qualityEvent;
}

export async function addQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  phase: QualityEvidencePhase;
  kind: QualityEvidenceKind;
  fileName: string;
  mimeType?: string | null;
  description?: string | null;
  actorId: string;
  data: Uint8Array;
  adapter?: StorageAdapter;
}) {
  const fileName = input.fileName.trim();
  const description = input.description?.trim() || null;
  if (!fileName || fileName.length > 255) {
    throw new QualityEvidenceError(
      "INVALID_EVIDENCE_DATA",
      "Evidence requires a file name up to 255 characters",
    );
  }
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
  const checksum = sha256(input.data);
  const storageKey = storageKeyFor({
    organizationId: input.organizationId,
    eventId: input.eventId,
    evidenceId: id,
    checksum,
  });
  const adapter = input.adapter ?? storage;
  await adapter.put(storageKey, input.data);

  const snapshot: QualityEvidenceSnapshot = {
    id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    siteId: input.siteId,
    phase: input.phase,
    kind: input.kind,
    fileName,
    storageKey,
    mimeType: input.mimeType?.trim() || null,
    sizeBytes: input.data.byteLength,
    checksum,
    description,
    createdById: input.actorId,
    createdAt: new Date().toISOString(),
    removedAt: null,
    removedById: null,
  };

  try {
    await db.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: EVIDENCE_ENTITY,
          entityId: snapshot.id,
          action: "EVIDENCE_ATTACHED",
          afterJson: JSON.stringify(snapshot),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "QualityEvent",
          entityId: input.eventId,
          action: "EVIDENCE_ATTACHED",
          afterJson: JSON.stringify({
            evidenceId: snapshot.id,
            phase: snapshot.phase,
            kind: snapshot.kind,
            fileName: snapshot.fileName,
            checksum: snapshot.checksum,
          }),
        },
      });
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
  phase?: QualityEvidencePhase;
  includeRemoved?: boolean;
}) {
  try {
    await requireQualityEvent(input);
  } catch (error) {
    if (error instanceof QualityEvidenceError && error.code === "QUALITY_EVENT_NOT_FOUND") return null;
    throw error;
  }

  const marker = `"eventId":"${input.eventId}","organizationId":"${input.organizationId}","siteId":"${input.siteId}"`;
  const records = await db.auditLog.findMany({
    where: {
      entityType: EVIDENCE_ENTITY,
      afterJson: { contains: marker },
    },
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });

  const latest = new Map<string, { evidence: QualityEvidenceSnapshot; actorName: string }>();
  for (const record of records) {
    const evidence = parseEvidence(record.afterJson);
    if (!evidence) continue;
    if (
      evidence.eventId !== input.eventId ||
      evidence.organizationId !== input.organizationId ||
      evidence.siteId !== input.siteId ||
      (input.phase && evidence.phase !== input.phase)
    ) {
      continue;
    }
    latest.set(evidence.id, {
      evidence,
      actorName: record.actor?.displayName ?? "System",
    });
  }

  return [...latest.values()]
    .filter(({ evidence }) => input.includeRemoved || evidence.removedAt === null)
    .sort((left, right) => right.evidence.createdAt.localeCompare(left.evidence.createdAt))
    .map(({ evidence, actorName }) => ({ ...evidence, actorName }));
}

export async function getQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  evidenceId: string;
  includeRemoved?: boolean;
}) {
  await requireQualityEvent(input);
  const records = await db.auditLog.findMany({
    where: { entityType: EVIDENCE_ENTITY, entityId: input.evidenceId },
    orderBy: { createdAt: "asc" },
    select: { afterJson: true },
  });
  const evidence = records.reduce<QualityEvidenceSnapshot | null>((latest, record) => {
    return parseEvidence(record.afterJson) ?? latest;
  }, null);
  if (
    !evidence ||
    evidence.organizationId !== input.organizationId ||
    evidence.siteId !== input.siteId ||
    evidence.eventId !== input.eventId ||
    (!input.includeRemoved && evidence.removedAt !== null)
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
  if (sha256(data) !== evidence.checksum) {
    throw new QualityEvidenceError(
      "FILE_INTEGRITY_FAILED",
      "Stored quality evidence does not match its recorded SHA-256 checksum",
    );
  }
  return { ...evidence, data };
}

export async function removeQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  evidenceId: string;
  actorId: string;
}) {
  await requireQualityEvent({ ...input, writable: true });
  const current = await getQualityEvidence({ ...input, includeRemoved: false });
  const removed: QualityEvidenceSnapshot = {
    ...current,
    removedAt: new Date().toISOString(),
    removedById: input.actorId,
  };

  await db.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: EVIDENCE_ENTITY,
        entityId: input.evidenceId,
        action: "EVIDENCE_REMOVED",
        beforeJson: JSON.stringify(current),
        afterJson: JSON.stringify(removed),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: "QualityEvent",
        entityId: input.eventId,
        action: "EVIDENCE_REMOVED",
        afterJson: JSON.stringify({
          evidenceId: current.id,
          phase: current.phase,
          kind: current.kind,
          fileName: current.fileName,
        }),
      },
    });
  });

  return { evidence: removed, storageRetained: true };
}
