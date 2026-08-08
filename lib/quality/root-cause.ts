import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const RCA_ENTITY_TYPE = "QualityRca";
const EVENT_ENTITY_TYPE = "QualityEvent";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type RcaStatus = "DRAFT" | "FINAL";
export type IshikawaCategory =
  | "PEOPLE"
  | "MACHINE"
  | "METHOD"
  | "MATERIAL"
  | "MEASUREMENT"
  | "ENVIRONMENT";
export type RootCauseSource = "FIVE_WHY" | "ISHIKAWA";

export type FiveWhyStep = {
  id: string;
  sequence: number;
  answer: string;
};

export type IshikawaCause = {
  id: string;
  category: IshikawaCategory;
  statement: string;
};

export type RootCauseReference = {
  source: RootCauseSource;
  refId: string;
};

export type QualityRcaSnapshot = {
  id: string;
  organizationId: string;
  siteId: string;
  eventId: string;
  eventNumber: string;
  eventTitle: string;
  status: RcaStatus;
  problemStatement: string;
  fiveWhys: FiveWhyStep[];
  ishikawaCauses: IshikawaCause[];
  rootCauses: RootCauseReference[];
  createdById: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
};

type QualityEventContext = {
  id: string;
  organizationId: string;
  siteId: string;
  eventNumber: string;
  title: string;
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
};

export class QualityRcaError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "RCA_NOT_ALLOWED"
      | "RCA_NOT_FOUND"
      | "RCA_FINAL"
      | "INVALID_FIVE_WHY_SEQUENCE"
      | "INVALID_ROOT_CAUSE_REFERENCE"
      | "ROOT_CAUSE_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "QualityRcaError";
  }
}

function rcaId(eventId: string) {
  return createHash("sha256").update(`quality-rca:${eventId}`).digest("hex");
}

function ishikawaId(category: IshikawaCategory, statement: string, index: number) {
  return createHash("sha256")
    .update(`${category}:${statement.trim().toLowerCase()}:${index}`)
    .digest("hex")
    .slice(0, 24);
}

function parseEvent(value: string | null): QualityEventContext | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualityEventContext>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.eventNumber !== "string" ||
      typeof parsed.title !== "string" ||
      (parsed.status !== "OPEN" &&
        parsed.status !== "CONTAINED" &&
        parsed.status !== "INVESTIGATING" &&
        parsed.status !== "CLOSED")
    ) {
      return null;
    }
    return parsed as QualityEventContext;
  } catch {
    return null;
  }
}

function isCategory(value: unknown): value is IshikawaCategory {
  return (
    value === "PEOPLE" ||
    value === "MACHINE" ||
    value === "METHOD" ||
    value === "MATERIAL" ||
    value === "MEASUREMENT" ||
    value === "ENVIRONMENT"
  );
}

function parseRca(value: string | null): QualityRcaSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualityRcaSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.eventId !== "string" ||
      typeof parsed.eventNumber !== "string" ||
      typeof parsed.eventTitle !== "string" ||
      (parsed.status !== "DRAFT" && parsed.status !== "FINAL") ||
      typeof parsed.problemStatement !== "string" ||
      !Array.isArray(parsed.fiveWhys) ||
      !Array.isArray(parsed.ishikawaCauses) ||
      !Array.isArray(parsed.rootCauses) ||
      typeof parsed.createdById !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !(parsed.finalizedAt === null || typeof parsed.finalizedAt === "string")
    ) {
      return null;
    }
    if (
      !parsed.fiveWhys.every(
        (step) =>
          step &&
          typeof step === "object" &&
          typeof step.id === "string" &&
          typeof step.sequence === "number" &&
          typeof step.answer === "string",
      ) ||
      !parsed.ishikawaCauses.every(
        (cause) =>
          cause &&
          typeof cause === "object" &&
          typeof cause.id === "string" &&
          isCategory(cause.category) &&
          typeof cause.statement === "string",
      ) ||
      !parsed.rootCauses.every(
        (reference) =>
          reference &&
          typeof reference === "object" &&
          (reference.source === "FIVE_WHY" || reference.source === "ISHIKAWA") &&
          typeof reference.refId === "string",
      )
    ) {
      return null;
    }
    return parsed as QualityRcaSnapshot;
  } catch {
    return null;
  }
}

async function latestEvent(tx: Prisma.TransactionClient, eventId: string) {
  const log = await tx.auditLog.findFirst({
    where: { entityType: EVENT_ENTITY_TYPE, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseEvent(log?.afterJson ?? null);
}

async function latestRca(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  const log = await client.auditLog.findFirst({
    where: { entityType: RCA_ENTITY_TYPE, entityId: rcaId(eventId) },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseRca(log?.afterJson ?? null);
}

function requireEventScope(
  event: QualityEventContext | null,
  input: { organizationId: string; siteId: string },
) {
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    throw new QualityRcaError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  return event;
}

function ensureRcaAllowed(event: QualityEventContext) {
  if (event.status === "OPEN" || event.status === "CLOSED") {
    throw new QualityRcaError(
      "RCA_NOT_ALLOWED",
      "Root-cause analysis requires a contained or investigating quality event",
    );
  }
}

function normalizeFiveWhys(input: Array<{ sequence: number; answer: string }>) {
  const steps = input
    .map((step) => ({ sequence: step.sequence, answer: step.answer.trim() }))
    .filter((step) => step.answer.length > 0)
    .sort((left, right) => left.sequence - right.sequence);

  if (
    steps.length > 5 ||
    steps.some((step, index) => step.sequence !== index + 1 || step.sequence < 1 || step.sequence > 5)
  ) {
    throw new QualityRcaError(
      "INVALID_FIVE_WHY_SEQUENCE",
      "5 Why steps must be contiguous from 1 through at most 5",
    );
  }

  return steps.map((step) => ({
    id: `why-${step.sequence}`,
    sequence: step.sequence,
    answer: step.answer,
  }));
}

function normalizeIshikawa(input: Array<{ category: IshikawaCategory; statement: string }>) {
  return input
    .map((cause) => ({ ...cause, statement: cause.statement.trim() }))
    .filter((cause) => cause.statement.length > 0)
    .map((cause, index) => ({
      id: ishikawaId(cause.category, cause.statement, index),
      category: cause.category,
      statement: cause.statement,
    }));
}

function validateRootCauses(
  rootCauses: RootCauseReference[],
  fiveWhys: FiveWhyStep[],
  ishikawaCauses: IshikawaCause[],
) {
  const validWhyIds = new Set(fiveWhys.map((step) => step.id));
  const validIshikawaIds = new Set(ishikawaCauses.map((cause) => cause.id));
  for (const reference of rootCauses) {
    const valid =
      reference.source === "FIVE_WHY"
        ? validWhyIds.has(reference.refId)
        : validIshikawaIds.has(reference.refId);
    if (!valid) {
      throw new QualityRcaError(
        "INVALID_ROOT_CAUSE_REFERENCE",
        "Root-cause references must point to a current 5 Why step or Ishikawa cause",
      );
    }
  }
}

async function appendRca(
  tx: Prisma.TransactionClient,
  snapshot: QualityRcaSnapshot,
  input: { actorId: string; action: string; previous?: QualityRcaSnapshot | null },
) {
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: RCA_ENTITY_TYPE,
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

export async function saveQualityRca(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  problemStatement: string;
  fiveWhys: Array<{ sequence: number; answer: string }>;
  ishikawaCauses: Array<{ category: IshikawaCategory; statement: string }>;
  rootCauses: RootCauseReference[];
  actorId: string;
}) {
  return serializable(async (tx) => {
    const event = requireEventScope(await latestEvent(tx, input.eventId), input);
    ensureRcaAllowed(event);
    const previous = await latestRca(tx, input.eventId);
    if (previous?.status === "FINAL") {
      throw new QualityRcaError("RCA_FINAL", "Final root-cause analysis is immutable");
    }

    const fiveWhys = normalizeFiveWhys(input.fiveWhys);
    const ishikawaCauses = normalizeIshikawa(input.ishikawaCauses);
    validateRootCauses(input.rootCauses, fiveWhys, ishikawaCauses);
    const timestamp = new Date().toISOString();
    const snapshot: QualityRcaSnapshot = {
      id: rcaId(input.eventId),
      organizationId: input.organizationId,
      siteId: input.siteId,
      eventId: event.id,
      eventNumber: previous?.eventNumber ?? event.eventNumber,
      eventTitle: previous?.eventTitle ?? event.title,
      status: "DRAFT",
      problemStatement: input.problemStatement.trim(),
      fiveWhys,
      ishikawaCauses,
      rootCauses: input.rootCauses,
      createdById: previous?.createdById ?? input.actorId,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      finalizedAt: null,
    };
    await appendRca(tx, snapshot, {
      actorId: input.actorId,
      action: previous ? "RCA_UPDATED" : "RCA_CREATED",
      previous,
    });
    return snapshot;
  });
}

export async function finalizeQualityRca(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const event = requireEventScope(await latestEvent(tx, input.eventId), input);
    if (event.status !== "INVESTIGATING") {
      throw new QualityRcaError(
        "RCA_NOT_ALLOWED",
        "Root-cause analysis can only be finalized while the quality event is investigating",
      );
    }
    const previous = await latestRca(tx, input.eventId);
    if (!previous) throw new QualityRcaError("RCA_NOT_FOUND", "Root-cause analysis not found");
    if (previous.status === "FINAL") return previous;
    if (previous.rootCauses.length === 0) {
      throw new QualityRcaError(
        "ROOT_CAUSE_REQUIRED",
        "At least one analyzed cause must be selected as a root cause before finalization",
      );
    }
    validateRootCauses(previous.rootCauses, previous.fiveWhys, previous.ishikawaCauses);

    const timestamp = new Date().toISOString();
    const snapshot: QualityRcaSnapshot = {
      ...previous,
      status: "FINAL",
      updatedAt: timestamp,
      finalizedAt: timestamp,
    };
    await appendRca(tx, snapshot, {
      actorId: input.actorId,
      action: "RCA_FINALIZED",
      previous,
    });
    return snapshot;
  });
}

export async function getQualityRca(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const snapshot = await latestRca(
    db as unknown as Pick<Prisma.TransactionClient, "auditLog">,
    input.eventId,
  );
  if (
    !snapshot ||
    snapshot.organizationId !== input.organizationId ||
    snapshot.siteId !== input.siteId
  ) {
    return null;
  }
  return snapshot;
}

export async function listQualityRcaTimeline(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const current = await getQualityRca(input);
  if (!current) return null;
  const logs = await db.auditLog.findMany({
    where: { entityType: RCA_ENTITY_TYPE, entityId: current.id },
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    actorName: log.actor?.displayName ?? "System",
    createdAt: log.createdAt,
    before: parseRca(log.beforeJson),
    after: parseRca(log.afterJson),
  }));
}
