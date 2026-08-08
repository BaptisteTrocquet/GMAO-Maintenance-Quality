import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const EFFECTIVENESS_ENTITY = "QualityCapaEffectiveness";
const CAPA_ENTITY = "QualityCapa";
const QUALITY_EVENT_ENTITY = "QualityEvent";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type EffectivenessResult = "EFFECTIVE" | "INEFFECTIVE";
export type EffectivenessStatus = "PENDING" | "VERIFIED";

export type CapaEffectivenessSnapshot = {
  eventId: string;
  organizationId: string;
  siteId: string;
  status: EffectivenessStatus;
  criteria: string;
  verifierId: string;
  verifierName: string;
  dueAt: string;
  result: EffectivenessResult | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
};

type EventSnapshot = {
  organizationId: string;
  siteId: string;
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
};

type CapaActionSnapshot = {
  id: string;
  actionKey: string;
  type: "CORRECTIVE" | "PREVENTIVE";
  title: string;
  description: string | null;
  ownerId: string;
  dueAt: string;
  status: "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  completionNote: string | null;
  completedAt: string | null;
};

type CapaSnapshot = {
  eventId: string;
  organizationId: string;
  siteId: string;
  status: "DRAFT" | "ACTIVE" | "READY_FOR_EFFECTIVENESS";
  objective: string;
  actions: CapaActionSnapshot[];
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  readyForEffectivenessAt: string | null;
};

export class CapaEffectivenessError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "EVENT_NOT_INVESTIGATING"
      | "CAPA_NOT_READY"
      | "VERIFIER_NOT_FOUND"
      | "INVALID_EFFECTIVENESS_DATA"
      | "EFFECTIVENESS_NOT_FOUND"
      | "EFFECTIVENESS_ALREADY_VERIFIED"
      | "EFFECTIVENESS_VERIFIER_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "CapaEffectivenessError";
  }
}

function parseEvent(value: string | null): EventSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<EventSnapshot>;
    if (
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "OPEN" &&
        parsed.status !== "CONTAINED" &&
        parsed.status !== "INVESTIGATING" &&
        parsed.status !== "CLOSED")
    ) return null;
    return parsed as EventSnapshot;
  } catch {
    return null;
  }
}

function parseCapa(value: string | null): CapaSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CapaSnapshot>;
    if (
      typeof parsed.eventId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "DRAFT" &&
        parsed.status !== "ACTIVE" &&
        parsed.status !== "READY_FOR_EFFECTIVENESS") ||
      typeof parsed.objective !== "string" ||
      !Array.isArray(parsed.actions) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) return null;
    return parsed as CapaSnapshot;
  } catch {
    return null;
  }
}

function parseEffectiveness(value: string | null): CapaEffectivenessSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CapaEffectivenessSnapshot>;
    if (
      typeof parsed.eventId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "PENDING" && parsed.status !== "VERIFIED") ||
      typeof parsed.criteria !== "string" ||
      typeof parsed.verifierId !== "string" ||
      typeof parsed.verifierName !== "string" ||
      typeof parsed.dueAt !== "string" ||
      !(parsed.result === null || parsed.result === "EFFECTIVE" || parsed.result === "INEFFECTIVE") ||
      !(parsed.summary === null || typeof parsed.summary === "string") ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !(parsed.verifiedAt === null || typeof parsed.verifiedAt === "string")
    ) return null;
    return parsed as CapaEffectivenessSnapshot;
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

async function latestJson(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  entityType: string,
  entityId: string,
) {
  const record = await client.auditLog.findFirst({
    where: { entityType, entityId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return record?.afterJson ?? null;
}

async function requireInvestigatingEvent(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const event = parseEvent(await latestJson(tx, QUALITY_EVENT_ENTITY, input.eventId));
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    throw new CapaEffectivenessError(
      "QUALITY_EVENT_NOT_FOUND",
      "Quality event not found in site scope",
    );
  }
  if (event.status !== "INVESTIGATING") {
    throw new CapaEffectivenessError(
      "EVENT_NOT_INVESTIGATING",
      "Effectiveness verification is available while the quality event is investigating",
    );
  }
}

async function requireReadyCapa(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const capa = parseCapa(await latestJson(tx, CAPA_ENTITY, input.eventId));
  if (
    !capa ||
    capa.organizationId !== input.organizationId ||
    capa.siteId !== input.siteId ||
    capa.status !== "READY_FOR_EFFECTIVENESS"
  ) {
    throw new CapaEffectivenessError(
      "CAPA_NOT_READY",
      "CAPA must be ready for effectiveness verification",
    );
  }
  return capa;
}

async function latestEffectiveness(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  return parseEffectiveness(await latestJson(client, EFFECTIVENESS_ENTITY, eventId));
}

async function resolveVerifier(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; verifierId: string },
) {
  const membership = await tx.organizationMembership.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.verifierId,
      active: true,
      user: { active: true },
      OR: [{ allSites: true }, { siteMemberships: { some: { siteId: input.siteId } } }],
    },
    select: { user: { select: { displayName: true } } },
  });
  if (!membership) {
    throw new CapaEffectivenessError(
      "VERIFIER_NOT_FOUND",
      "Effectiveness verifier must be an active organization member with access to this site",
    );
  }
  return membership.user.displayName;
}

async function appendEffectiveness(
  tx: Prisma.TransactionClient,
  snapshot: CapaEffectivenessSnapshot,
  input: {
    actorId: string;
    action: "EFFECTIVENESS_REVIEW_STARTED" | "CAPA_EFFECTIVE" | "CAPA_INEFFECTIVE";
    previous?: CapaEffectivenessSnapshot | null;
  },
) {
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: EFFECTIVENESS_ENTITY,
      entityId: snapshot.eventId,
      action: input.action,
      beforeJson: input.previous ? JSON.stringify(input.previous) : null,
      afterJson: JSON.stringify(snapshot),
    },
  });
}

export async function startCapaEffectivenessReview(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  criteria: string;
  verifierId: string;
  dueAt: Date;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    await requireReadyCapa(tx, input);
    const criteria = input.criteria.trim();
    if (!criteria || Number.isNaN(input.dueAt.getTime())) {
      throw new CapaEffectivenessError(
        "INVALID_EFFECTIVENESS_DATA",
        "Effectiveness review requires criteria and a valid due date",
      );
    }
    const previous = await latestEffectiveness(tx, input.eventId);
    if (previous?.status === "VERIFIED" && previous.result === "EFFECTIVE") {
      throw new CapaEffectivenessError(
        "EFFECTIVENESS_ALREADY_VERIFIED",
        "Effective CAPA verification is already complete",
      );
    }
    const verifierName = await resolveVerifier(tx, input);
    const now = new Date().toISOString();
    const snapshot: CapaEffectivenessSnapshot = {
      eventId: input.eventId,
      organizationId: input.organizationId,
      siteId: input.siteId,
      status: "PENDING",
      criteria,
      verifierId: input.verifierId,
      verifierName,
      dueAt: input.dueAt.toISOString(),
      result: null,
      summary: null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      verifiedAt: null,
    };
    await appendEffectiveness(tx, snapshot, {
      actorId: input.actorId,
      action: "EFFECTIVENESS_REVIEW_STARTED",
      previous,
    });
    return snapshot;
  });
}

export async function verifyCapaEffectiveness(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  result: EffectivenessResult;
  summary: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const capa = await requireReadyCapa(tx, input);
    const previous = await latestEffectiveness(tx, input.eventId);
    if (
      !previous ||
      previous.organizationId !== input.organizationId ||
      previous.siteId !== input.siteId ||
      previous.status !== "PENDING"
    ) {
      throw new CapaEffectivenessError(
        "EFFECTIVENESS_NOT_FOUND",
        "Pending effectiveness review not found",
      );
    }
    if (previous.verifierId !== input.actorId) {
      throw new CapaEffectivenessError(
        "EFFECTIVENESS_VERIFIER_REQUIRED",
        "Only the assigned effectiveness verifier can record the result",
      );
    }
    const summary = input.summary.trim();
    if (!summary) {
      throw new CapaEffectivenessError(
        "INVALID_EFFECTIVENESS_DATA",
        "Effectiveness verification requires a result summary",
      );
    }
    const now = new Date().toISOString();
    const snapshot: CapaEffectivenessSnapshot = {
      ...previous,
      status: "VERIFIED",
      result: input.result,
      summary,
      updatedAt: now,
      verifiedAt: now,
    };
    await appendEffectiveness(tx, snapshot, {
      actorId: input.actorId,
      action: input.result === "EFFECTIVE" ? "CAPA_EFFECTIVE" : "CAPA_INEFFECTIVE",
      previous,
    });

    if (input.result === "INEFFECTIVE") {
      const reopened: CapaSnapshot = {
        ...capa,
        status: "DRAFT",
        actions: [],
        updatedAt: now,
        activatedAt: null,
        readyForEffectivenessAt: null,
      };
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: CAPA_ENTITY,
          entityId: input.eventId,
          action: "CAPA_REOPENED_INEFFECTIVE",
          beforeJson: JSON.stringify(capa),
          afterJson: JSON.stringify(reopened),
        },
      });
    }

    return snapshot;
  });
}

export async function getCapaEffectiveness(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const event = parseEvent(
    await latestJson(
      db as unknown as Pick<Prisma.TransactionClient, "auditLog">,
      QUALITY_EVENT_ENTITY,
      input.eventId,
    ),
  );
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    return null;
  }
  const effectiveness = await latestEffectiveness(
    db as unknown as Pick<Prisma.TransactionClient, "auditLog">,
    input.eventId,
  );
  if (
    effectiveness &&
    (effectiveness.organizationId !== input.organizationId || effectiveness.siteId !== input.siteId)
  ) return null;
  return effectiveness;
}

export async function listCapaEffectivenessTimeline(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const scoped = await getCapaEffectiveness(input);
  if (scoped === null) return null;
  const records = await db.auditLog.findMany({
    where: { entityType: EFFECTIVENESS_ENTITY, entityId: input.eventId },
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
  return records.flatMap((record) => {
    const after = parseEffectiveness(record.afterJson);
    if (!after || after.organizationId !== input.organizationId || after.siteId !== input.siteId) return [];
    return [{
      id: record.id,
      action: record.action,
      createdAt: record.createdAt,
      actorName: record.actor?.displayName ?? "System",
      after,
    }];
  });
}
