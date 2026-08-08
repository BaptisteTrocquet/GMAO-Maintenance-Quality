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
export type QualityEventStatus = "OPEN" | "CONTAINMENT" | "CONTAINED";

export type QualityContainmentSnapshot = {
  summary: string;
  ownerId: string;
  dueAt: string | null;
  startedAt: string;
  completedAt: string | null;
  completionNote: string | null;
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
  createdAt: string;
  updatedAt: string;
};

export class QualityEventError extends Error {
  constructor(
    public readonly code:
      | "SITE_NOT_FOUND"
      | "QUALITY_EVENT_NOT_FOUND"
      | "CONTAINMENT_OWNER_NOT_FOUND"
      | "IDEMPOTENCY_CONFLICT"
      | "INVALID_STATUS_TRANSITION"
      | "EVENT_LOCKED",
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
      }),
    )
    .digest("hex");
}

function parseContainment(value: unknown): QualityContainmentSnapshot | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<QualityContainmentSnapshot>;
  if (
    typeof parsed.summary !== "string" ||
    typeof parsed.ownerId !== "string" ||
    !(parsed.dueAt === null || typeof parsed.dueAt === "string") ||
    typeof parsed.startedAt !== "string" ||
    !(parsed.completedAt === null || typeof parsed.completedAt === "string") ||
    !(parsed.completionNote === null || typeof parsed.completionNote === "string")
  ) {
    return null;
  }
  return parsed as QualityContainmentSnapshot;
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
      (parsed.status !== "OPEN" && parsed.status !== "CONTAINMENT" && parsed.status !== "CONTAINED")
    ) {
      return null;
    }

    const containment = parseContainment(parsed.containment);
    if (parsed.containment !== null && !containment) return null;
    return { ...parsed, containment } as QualityEventSnapshot;
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
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "CREATED" });
    return { qualityEvent: snapshot, idempotent: false } as const;
  });
}

export async function updateQualityEvent(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  type?: QualityEventType;
  severity?: QualitySeverity;
  title?: string;
  description?: string | null;
  occurredAt?: Date | null;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const previous = requireEventScope(await latestQualityEvent(tx, input.eventId), input);
    if (previous.status === "CONTAINED") {
      throw new QualityEventError("EVENT_LOCKED", "Contained quality events cannot be edited");
    }

    const snapshot: QualityEventSnapshot = {
      ...previous,
      type: input.type ?? previous.type,
      severity: input.severity ?? previous.severity,
      title: input.title ?? previous.title,
      description: input.description === undefined ? previous.description : input.description,
      occurredAt:
        input.occurredAt === undefined
          ? previous.occurredAt
          : input.occurredAt?.toISOString() ?? null,
      updatedAt: new Date().toISOString(),
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "UPDATED", previous });
    return snapshot;
  });
}

export async function startOrUpdateContainment(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  summary: string;
  ownerId?: string | null;
  dueAt?: Date | null;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const previous = requireEventScope(await latestQualityEvent(tx, input.eventId), input);
    if (previous.status === "CONTAINED") {
      throw new QualityEventError(
        "INVALID_STATUS_TRANSITION",
        "Completed containment cannot be reopened in this workflow stage",
      );
    }

    const ownerId = input.ownerId ?? previous.containment?.ownerId ?? input.actorId;
    await validateOwner(tx, { organizationId: input.organizationId, ownerId });
    const timestamp = new Date().toISOString();
    const snapshot: QualityEventSnapshot = {
      ...previous,
      status: "CONTAINMENT",
      containment: {
        summary: input.summary,
        ownerId,
        dueAt:
          input.dueAt === undefined
            ? previous.containment?.dueAt ?? null
            : input.dueAt?.toISOString() ?? null,
        startedAt: previous.containment?.startedAt ?? timestamp,
        completedAt: null,
        completionNote: null,
      },
      updatedAt: timestamp,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: previous.containment ? "CONTAINMENT_UPDATED" : "CONTAINMENT_STARTED",
      previous,
    });
    return snapshot;
  });
}

export async function completeContainment(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  completionNote?: string | null;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const previous = requireEventScope(await latestQualityEvent(tx, input.eventId), input);
    if (previous.status !== "CONTAINMENT" || !previous.containment) {
      throw new QualityEventError(
        "INVALID_STATUS_TRANSITION",
        "Containment must be started before it can be completed",
      );
    }

    const timestamp = new Date().toISOString();
    const snapshot: QualityEventSnapshot = {
      ...previous,
      status: "CONTAINED",
      containment: {
        ...previous.containment,
        completedAt: timestamp,
        completionNote: input.completionNote ?? null,
      },
      updatedAt: timestamp,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: "CONTAINMENT_COMPLETED",
      previous,
    });
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
  const marker = `\"organizationId\":\"${input.organizationId}\",\"siteId\":\"${input.siteId}\"`;
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
  return db.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, entityId: input.eventId },
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
}
