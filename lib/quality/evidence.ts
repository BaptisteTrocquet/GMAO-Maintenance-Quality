import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getQualityEvent } from "@/lib/quality/events";

const EVIDENCE_ENTITY = "QualityEvidenceAttachment";

export type QualityEvidencePhase =
  | "EVENT"
  | "CONTAINMENT"
  | "ROOT_CAUSE"
  | "CAPA"
  | "EFFECTIVENESS";

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
  sizeBytes: number | null;
  description: string | null;
  createdById: string;
  createdAt: string;
};

export class QualityEvidenceError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "EVENT_CLOSED"
      | "INVALID_EVIDENCE_DATA",
    message: string,
  ) {
    super(message);
    this.name = "QualityEvidenceError";
  }
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
        parsed.phase !== "EFFECTIVENESS") ||
      (parsed.kind !== "DOCUMENT" && parsed.kind !== "PHOTO" && parsed.kind !== "RECORD") ||
      typeof parsed.fileName !== "string" ||
      typeof parsed.storageKey !== "string" ||
      !(parsed.mimeType === null || typeof parsed.mimeType === "string") ||
      !(parsed.sizeBytes === null || typeof parsed.sizeBytes === "number") ||
      !(parsed.description === null || typeof parsed.description === "string") ||
      typeof parsed.createdById !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return parsed as QualityEvidenceSnapshot;
  } catch {
    return null;
  }
}

export async function addQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  phase: QualityEvidencePhase;
  kind: QualityEvidenceKind;
  fileName: string;
  storageKey: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  description?: string | null;
  actorId: string;
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
  if (qualityEvent.status === "CLOSED") {
    throw new QualityEvidenceError(
      "EVENT_CLOSED",
      "Evidence cannot be added after the quality event is closed",
    );
  }

  const fileName = input.fileName.trim();
  const storageKey = input.storageKey.trim();
  const description = input.description?.trim() || null;
  if (!fileName || !storageKey) {
    throw new QualityEvidenceError(
      "INVALID_EVIDENCE_DATA",
      "Evidence requires a file name and storage key",
    );
  }
  if (input.sizeBytes !== undefined && input.sizeBytes !== null && input.sizeBytes < 0) {
    throw new QualityEvidenceError(
      "INVALID_EVIDENCE_DATA",
      "Evidence size cannot be negative",
    );
  }

  const snapshot: QualityEvidenceSnapshot = {
    id: randomUUID(),
    eventId: input.eventId,
    organizationId: input.organizationId,
    siteId: input.siteId,
    phase: input.phase,
    kind: input.kind,
    fileName,
    storageKey,
    mimeType: input.mimeType?.trim() || null,
    sizeBytes: input.sizeBytes ?? null,
    description,
    createdById: input.actorId,
    createdAt: new Date().toISOString(),
  };

  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: EVIDENCE_ENTITY,
      entityId: snapshot.id,
      action: "EVIDENCE_ATTACHED",
      afterJson: JSON.stringify(snapshot),
    },
  });
  await db.auditLog.create({
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
      }),
    },
  });

  return snapshot;
}

export async function listQualityEvidence(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  phase?: QualityEvidencePhase;
}) {
  const qualityEvent = await getQualityEvent({
    organizationId: input.organizationId,
    siteId: input.siteId,
    eventId: input.eventId,
  });
  if (!qualityEvent) return null;

  const marker = `\"eventId\":\"${input.eventId}\",\"organizationId\":\"${input.organizationId}\",\"siteId\":\"${input.siteId}\"`;
  const records = await db.auditLog.findMany({
    where: {
      entityType: EVIDENCE_ENTITY,
      afterJson: { contains: marker },
    },
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: "desc" },
  });

  return records.flatMap((record) => {
    const evidence = parseEvidence(record.afterJson);
    if (!evidence) return [];
    if (
      evidence.eventId !== input.eventId ||
      evidence.organizationId !== input.organizationId ||
      evidence.siteId !== input.siteId ||
      (input.phase && evidence.phase !== input.phase)
    ) {
      return [];
    }
    return [{
      ...evidence,
      actorName: record.actor?.displayName ?? "System",
    }];
  });
}
