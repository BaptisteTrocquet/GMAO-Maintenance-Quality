import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const ENTITY_TYPE = "QualityEvent";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type QualityEventType =
  | "NONCONFORMITY"
  | "OBSERVATION"
  | "AUDIT_FINDING"
  | "COMPLAINT"
  | "DEVIATION"
  | "OTHER";

export type QualitySeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type QualityEventStatus = "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";

export type QualityAssetSnapshot = {
  id: string;
  code: string;
  name: string;
};

export type QualityWorkOrderSnapshot = {
  id: string;
  number: string;
  title: string;
};

export type QualityDocumentSnapshot = {
  id: string;
  code: string;
  title: string;
};

export type QualityContainmentSnapshot = {
  summary: string;
  ownerId: string;
  dueAt: string | null;
  completedAt: string | null;
};

export type QualityEventSnapshot = {
  id: string;
  eventNumber: string;
  eventKey: string;
  requestHash: string;
  organizationId: string;
  siteId: string;
  type: QualityEventType;
  severity: QualitySeverity;
  status: QualityEventStatus;
  title: string;
  description: string | null;
  occurredAt: string | null;
  detectedAt: string;
  detectedById: string;
  containment: QualityContainmentSnapshot | null;
  asset: QualityAssetSnapshot | null;
  workOrder: QualityWorkOrderSnapshot | null;
  documents: QualityDocumentSnapshot[];
  resolutionSummary: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export class QualityEventError extends Error {
  constructor(
    public readonly code:
      | "SITE_NOT_FOUND"
      | "ASSET_NOT_FOUND"
      | "WORK_ORDER_NOT_FOUND"
      | "DOCUMENT_NOT_FOUND"
      | "QUALITY_EVENT_NOT_FOUND"
      | "CONTAINMENT_OWNER_NOT_FOUND"
      | "IDEMPOTENCY_CONFLICT"
      | "INVALID_STATUS_TRANSITION"
      | "CONTAINMENT_REQUIRED"
      | "RESOLUTION_REQUIRED"
      | "EVENT_CLOSED",
    message: string,
  ) {
    super(message);
    this.name = "QualityEventError";
  }
}

function stableEventId(organizationId: string, siteId: string, eventKey: string) {
  return createHash("sha256").update(`${organizationId}:${siteId}:${eventKey}`).digest("hex");
}

function createRequestHash(input: {
  organizationId: string;
  siteId: string;
  eventKey: string;
  type: QualityEventType;
  severity: QualitySeverity;
  title: string;
  description?: string | null;
  occurredAt?: Date | null;
  assetId?: string | null;
  workOrderId?: string | null;
  documentIds?: string[];
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        organizationId: input.organizationId,
        siteId: input.siteId,
        eventKey: input.eventKey,
        type: input.type,
        severity: input.severity,
        title: input.title,
        description: input.description ?? null,
        occurredAt: input.occurredAt?.toISOString() ?? null,
        assetId: input.assetId ?? null,
        workOrderId: input.workOrderId ?? null,
        documentIds: [...(input.documentIds ?? [])].sort(),
      }),
    )
    .digest("hex");
}

function parseSnapshot(value: string | null): QualityEventSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualityEventSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.eventNumber !== "string" ||
      typeof parsed.eventKey !== "string" ||
      typeof parsed.requestHash !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.title !== "string" ||
      !(parsed.description === null || typeof parsed.description === "string") ||
      !(parsed.occurredAt === null || typeof parsed.occurredAt === "string") ||
      typeof parsed.detectedAt !== "string" ||
      typeof parsed.detectedById !== "string" ||
      !Array.isArray(parsed.documents) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      (parsed.type !== "NONCONFORMITY" &&
        parsed.type !== "OBSERVATION" &&
        parsed.type !== "AUDIT_FINDING" &&
        parsed.type !== "COMPLAINT" &&
        parsed.type !== "DEVIATION" &&
        parsed.type !== "OTHER") ||
      (parsed.severity !== "LOW" &&
        parsed.severity !== "MEDIUM" &&
        parsed.severity !== "HIGH" &&
        parsed.severity !== "CRITICAL") ||
      (parsed.status !== "OPEN" &&
        parsed.status !== "CONTAINED" &&
        parsed.status !== "INVESTIGATING" &&
        parsed.status !== "CLOSED")
    ) {
      return null;
    }
    return parsed as QualityEventSnapshot;
  } catch {
    return null;
  }
}

async function latestQualityEvent(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  const event = await client.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseSnapshot(event?.afterJson ?? null);
}

async function appendSnapshot(
  tx: Prisma.TransactionClient,
  snapshot: QualityEventSnapshot,
  input: { actorId: string; action: string; previous?: QualityEventSnapshot | null },
) {
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: ENTITY_TYPE,
      entityId: snapshot.id,
      action: input.action,
      beforeJson: input.previous ? JSON.stringify(input.previous) : null,
      afterJson: JSON.stringify(snapshot),
    },
  });
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

async function validateSite(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string },
) {
  const site = await tx.site.findFirst({
    where: { id: input.siteId, organizationId: input.organizationId, active: true },
    select: { id: true },
  });
  if (!site) {
    throw new QualityEventError("SITE_NOT_FOUND", "Active site not found in organization scope");
  }
}

async function validateOwner(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; ownerId: string },
) {
  const membership = await tx.organizationMembership.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.ownerId,
      active: true,
      user: { active: true },
    },
    select: { id: true },
  });
  if (!membership) {
    throw new QualityEventError(
      "CONTAINMENT_OWNER_NOT_FOUND",
      "Containment owner is not an active member of this organization",
    );
  }
}

async function resolveLinks(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    siteId: string;
    assetId?: string | null;
    workOrderId?: string | null;
    documentIds?: string[];
  },
) {
  const asset = input.assetId
    ? await tx.asset.findFirst({
        where: { id: input.assetId, siteId: input.siteId },
        select: { id: true, code: true, name: true },
      })
    : null;
  if (input.assetId && !asset) {
    throw new QualityEventError("ASSET_NOT_FOUND", "Asset not found in site scope");
  }

  const workOrder = input.workOrderId
    ? await tx.workOrder.findFirst({
        where: { id: input.workOrderId, siteId: input.siteId },
        select: { id: true, number: true, title: true },
      })
    : null;
  if (input.workOrderId && !workOrder) {
    throw new QualityEventError("WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }

  const documentIds = [...new Set(input.documentIds ?? [])];
  const documents = documentIds.length
    ? await tx.document.findMany({
        where: { id: { in: documentIds }, organizationId: input.organizationId },
        select: { id: true, code: true, title: true },
      })
    : [];
  if (documents.length !== documentIds.length) {
    throw new QualityEventError(
      "DOCUMENT_NOT_FOUND",
      "One or more controlled documents were not found in organization scope",
    );
  }
  const documentById = new Map(documents.map((document) => [document.id, document]));

  return {
    asset: asset ? { id: asset.id, code: asset.code, name: asset.name } : null,
    workOrder: workOrder
      ? { id: workOrder.id, number: workOrder.number, title: workOrder.title }
      : null,
    documents: documentIds.map((id) => {
      const document = documentById.get(id);
      if (!document) throw new QualityEventError("DOCUMENT_NOT_FOUND", "Controlled document not found");
      return { id: document.id, code: document.code, title: document.title };
    }),
  };
}

function requireEventScope(
  event: QualityEventSnapshot | null,
  input: { organizationId: string; siteId: string },
) {
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    throw new QualityEventError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  return event;
}

export async function createQualityEvent(input: {
  organizationId: string;
  siteId: string;
  eventKey: string;
  type: QualityEventType;
  severity: QualitySeverity;
  title: string;
  description?: string | null;
  occurredAt?: Date | null;
  assetId?: string | null;
  workOrderId?: string | null;
  documentIds?: string[];
  actorId: string;
}) {
  const id = stableEventId(input.organizationId, input.siteId, input.eventKey);
  const requestHash = createRequestHash(input);

  return serializable(async (tx) => {
    const existing = await latestQualityEvent(tx, id);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new QualityEventError(
          "IDEMPOTENCY_CONFLICT",
          "eventKey was already used for a different quality event payload",
        );
      }
      return { qualityEvent: existing, idempotent: true } as const;
    }

    await validateSite(tx, input);
    const links = await resolveLinks(tx, input);
    const timestamp = new Date().toISOString();
    const snapshot: QualityEventSnapshot = {
      id,
      eventNumber: `QE-${id.slice(0, 8).toUpperCase()}`,
      eventKey: input.eventKey,
      requestHash,
      organizationId: input.organizationId,
      siteId: input.siteId,
      type: input.type,
      severity: input.severity,
      status: "OPEN",
      title: input.title,
      description: input.description ?? null,
      occurredAt: input.occurredAt?.toISOString() ?? null,
      detectedAt: timestamp,
      detectedById: input.actorId,
      containment: null,
      asset: links.asset,
      workOrder: links.workOrder,
      documents: links.documents,
      resolutionSummary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "CREATED" });
    return { qualityEvent: snapshot, idempotent: false } as const;
  });
}

export async function setImmediateContainment(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  summary: string;
  ownerId?: string | null;
  dueAt?: Date | null;
  completedAt?: Date | null;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const previous = requireEventScope(await latestQualityEvent(tx, input.eventId), input);
    if (previous.status === "CLOSED") {
      throw new QualityEventError("EVENT_CLOSED", "Closed quality events cannot be modified");
    }

    const ownerId = input.ownerId ?? previous.containment?.ownerId ?? input.actorId;
    await validateOwner(tx, { organizationId: input.organizationId, ownerId });
    const snapshot: QualityEventSnapshot = {
      ...previous,
      containment: {
        summary: input.summary,
        ownerId,
        dueAt:
          input.dueAt === undefined
            ? previous.containment?.dueAt ?? null
            : input.dueAt?.toISOString() ?? null,
        completedAt:
          input.completedAt === undefined
            ? previous.containment?.completedAt ?? null
            : input.completedAt?.toISOString() ?? null,
      },
      status: previous.status === "OPEN" ? "CONTAINED" : previous.status,
      updatedAt: new Date().toISOString(),
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: previous.containment ? "CONTAINMENT_UPDATED" : "CONTAINMENT_RECORDED",
      previous,
    });
    return snapshot;
  });
}

function transitionStatus(
  previous: QualityEventSnapshot,
  action: "START_INVESTIGATION" | "CLOSE" | "REOPEN",
  resolutionSummary?: string | null,
) {
  if (
    action === "START_INVESTIGATION" &&
    (previous.status === "OPEN" || previous.status === "CONTAINED")
  ) {
    return {
      status: "INVESTIGATING" as const,
      resolutionSummary: previous.resolutionSummary,
      closedAt: null,
    };
  }

  if (action === "CLOSE" && (previous.status === "CONTAINED" || previous.status === "INVESTIGATING")) {
    if (!previous.containment) {
      throw new QualityEventError(
        "CONTAINMENT_REQUIRED",
        "Immediate containment must be recorded before closing a quality event",
      );
    }
    const resolution = resolutionSummary?.trim();
    if (!resolution) {
      throw new QualityEventError(
        "RESOLUTION_REQUIRED",
        "A resolution summary is required before closing a quality event",
      );
    }
    return {
      status: "CLOSED" as const,
      resolutionSummary: resolution,
      closedAt: new Date().toISOString(),
    };
  }

  if (action === "REOPEN" && previous.status === "CLOSED") {
    return {
      status: "INVESTIGATING" as const,
      resolutionSummary: previous.resolutionSummary,
      closedAt: null,
    };
  }

  throw new QualityEventError(
    "INVALID_STATUS_TRANSITION",
    `Cannot ${action.toLowerCase()} quality event from ${previous.status}`,
  );
}

export async function transitionQualityEvent(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  action: "START_INVESTIGATION" | "CLOSE" | "REOPEN";
  resolutionSummary?: string | null;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const previous = requireEventScope(await latestQualityEvent(tx, input.eventId), input);
    const transition = transitionStatus(previous, input.action, input.resolutionSummary);
    const snapshot: QualityEventSnapshot = {
      ...previous,
      ...transition,
      updatedAt: new Date().toISOString(),
    };
    const action =
      input.action === "START_INVESTIGATION"
        ? "INVESTIGATION_STARTED"
        : input.action === "CLOSE"
          ? "CLOSED"
          : "REOPENED";
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action, previous });
    return snapshot;
  });
}

export async function getQualityEvent(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const event = await latestQualityEvent(
    db as unknown as Pick<Prisma.TransactionClient, "auditLog">,
    input.eventId,
  );
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    return null;
  }
  return event;
}

export async function listQualityEvents(input: {
  organizationId: string;
  siteId: string;
  status?: QualityEventStatus;
  type?: QualityEventType;
  severity?: QualitySeverity;
}) {
  const marker = `"organizationId":"${input.organizationId}","siteId":"${input.siteId}"`;
  const logs = await db.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, afterJson: { contains: marker } },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });

  const latest = new Map<string, QualityEventSnapshot>();
  for (const log of logs) {
    const snapshot = parseSnapshot(log.afterJson);
    if (snapshot) latest.set(log.entityId, snapshot);
  }

  return [...latest.values()]
    .filter((event) => !input.status || event.status === input.status)
    .filter((event) => !input.type || event.type === input.type)
    .filter((event) => !input.severity || event.severity === input.severity)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function listQualityEventTimeline(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const current = await getQualityEvent(input);
  if (!current) return null;

  const logs = await db.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, entityId: input.eventId },
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });

  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    actorName: log.actor?.displayName ?? "System",
    createdAt: log.createdAt,
    before: parseSnapshot(log.beforeJson),
    after: parseSnapshot(log.afterJson),
  }));
}
