import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const ENTITY_TYPE = "QualityCapa";
const QUALITY_EVENT_ENTITY_TYPE = "QualityEvent";
const ROOT_CAUSE_ENTITY_TYPE = "QualityRootCause";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type CapaStatus = "DRAFT" | "ACTIVE" | "CLOSED";
export type CapaActionType = "CORRECTIVE" | "PREVENTIVE";
export type CapaActionStatus = "OPEN" | "COMPLETED";
export type EffectivenessResult = "EFFECTIVE" | "INEFFECTIVE";

export type CapaAction = {
  id: string;
  type: CapaActionType;
  title: string;
  description: string | null;
  ownerId: string;
  dueAt: string;
  status: CapaActionStatus;
  completionNote: string | null;
  completedById: string | null;
  completedAt: string | null;
};

export type EffectivenessCheck = {
  result: EffectivenessResult;
  note: string;
  verifiedById: string;
  verifiedAt: string;
};

export type CapaSnapshot = {
  eventId: string;
  organizationId: string;
  siteId: string;
  status: CapaStatus;
  planSummary: string;
  actions: CapaAction[];
  approvedById: string | null;
  approvedAt: string | null;
  effectivenessChecks: EffectivenessCheck[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

type QualityEventReference = {
  organizationId: string;
  siteId: string;
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
};

type RootCauseReference = {
  organizationId: string;
  siteId: string;
  status: "DRAFT" | "CONFIRMED";
};

export class CapaError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "INVESTIGATION_REQUIRED"
      | "EVENT_CLOSED"
      | "ROOT_CAUSE_REQUIRED"
      | "CAPA_NOT_FOUND"
      | "CAPA_LOCKED"
      | "CAPA_ALREADY_CLOSED"
      | "ACTION_REQUIRED"
      | "ACTION_NOT_FOUND"
      | "ACTION_OWNER_NOT_FOUND"
      | "ACTION_COMPLETION_NOTE_REQUIRED"
      | "ACTIONS_INCOMPLETE"
      | "EFFECTIVENESS_NOTE_REQUIRED"
      | "INVALID_ACTIONS",
    message: string,
  ) {
    super(message);
    this.name = "CapaError";
  }
}

function parseQualityEvent(value: string | null): QualityEventReference | null {
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

function parseRootCause(value: string | null): RootCauseReference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RootCauseReference>;
    if (
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "DRAFT" && parsed.status !== "CONFIRMED")
    ) {
      return null;
    }
    return parsed as RootCauseReference;
  } catch {
    return null;
  }
}

function parseSnapshot(value: string | null): CapaSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CapaSnapshot>;
    if (
      typeof parsed.eventId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "DRAFT" && parsed.status !== "ACTIVE" && parsed.status !== "CLOSED") ||
      typeof parsed.planSummary !== "string" ||
      !Array.isArray(parsed.actions) ||
      !Array.isArray(parsed.effectivenessChecks) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !(parsed.approvedById === null || typeof parsed.approvedById === "string") ||
      !(parsed.approvedAt === null || typeof parsed.approvedAt === "string") ||
      !(parsed.closedAt === null || typeof parsed.closedAt === "string")
    ) {
      return null;
    }
    return parsed as CapaSnapshot;
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

async function currentQualityEvent(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  const log = await client.auditLog.findFirst({
    where: { entityType: QUALITY_EVENT_ENTITY_TYPE, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseQualityEvent(log?.afterJson ?? null);
}

async function currentRootCause(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  const log = await client.auditLog.findFirst({
    where: { entityType: ROOT_CAUSE_ENTITY_TYPE, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseRootCause(log?.afterJson ?? null);
}

export async function latestCapaSnapshot(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  const log = await client.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseSnapshot(log?.afterJson ?? null);
}

async function requireCapaContext(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const [event, rootCause] = await Promise.all([
    currentQualityEvent(tx, input.eventId),
    currentRootCause(tx, input.eventId),
  ]);
  if (
    !event ||
    event.organizationId !== input.organizationId ||
    event.siteId !== input.siteId
  ) {
    throw new CapaError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  if (event.status === "CLOSED") {
    throw new CapaError("EVENT_CLOSED", "Closed quality events cannot change CAPA");
  }
  if (event.status !== "INVESTIGATING") {
    throw new CapaError(
      "INVESTIGATION_REQUIRED",
      "Start the quality-event investigation before managing CAPA",
    );
  }
  if (
    !rootCause ||
    rootCause.organizationId !== input.organizationId ||
    rootCause.siteId !== input.siteId ||
    rootCause.status !== "CONFIRMED"
  ) {
    throw new CapaError(
      "ROOT_CAUSE_REQUIRED",
      "Confirm root-cause analysis before creating or approving CAPA",
    );
  }
}

async function validateActionOwner(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; ownerId: string },
) {
  const membership = await tx.organizationMembership.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.ownerId,
      active: true,
      user: { active: true },
      OR: [
        { allSites: true },
        { siteMemberships: { some: { siteId: input.siteId } } },
      ],
    },
    select: { id: true },
  });
  if (!membership) {
    throw new CapaError(
      "ACTION_OWNER_NOT_FOUND",
      "CAPA action owner must be an active member with access to this site",
    );
  }
}

async function appendSnapshot(
  tx: Prisma.TransactionClient,
  snapshot: CapaSnapshot,
  input: { actorId: string; action: string; previous?: CapaSnapshot | null },
) {
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: ENTITY_TYPE,
      entityId: snapshot.eventId,
      action: input.action,
      beforeJson: input.previous ? JSON.stringify(input.previous) : null,
      afterJson: JSON.stringify(snapshot),
    },
  });
}

export type SaveCapaActionInput = {
  id?: string;
  type: CapaActionType;
  title: string;
  description?: string | null;
  ownerId: string;
  dueAt: Date;
};

function actionMeaningChanged(existing: CapaAction, next: {
  type: CapaActionType;
  title: string;
  description: string | null;
  ownerId: string;
  dueAt: string;
}) {
  return (
    existing.type !== next.type ||
    existing.title !== next.title ||
    existing.description !== next.description ||
    existing.ownerId !== next.ownerId ||
    existing.dueAt !== next.dueAt
  );
}

export async function saveCapaDraft(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  planSummary: string;
  actions: SaveCapaActionInput[];
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireCapaContext(tx, input);
    const previous = await latestCapaSnapshot(tx, input.eventId);
    if (previous && previous.status !== "DRAFT") {
      throw new CapaError("CAPA_LOCKED", "Approved CAPA must be reopened before editing its plan");
    }

    const ids = new Set<string>();
    const previousById = new Map((previous?.actions ?? []).map((action) => [action.id, action]));
    const actions: CapaAction[] = [];
    for (const rawAction of input.actions) {
      const title = rawAction.title.trim();
      if (!title || !Number.isFinite(rawAction.dueAt.getTime())) {
        throw new CapaError("INVALID_ACTIONS", "Each CAPA action requires a title and valid due date");
      }
      await validateActionOwner(tx, {
        organizationId: input.organizationId,
        siteId: input.siteId,
        ownerId: rawAction.ownerId,
      });
      const id = rawAction.id?.trim() || randomUUID();
      if (ids.has(id)) {
        throw new CapaError("INVALID_ACTIONS", "CAPA action IDs must be unique");
      }
      ids.add(id);
      const existing = previousById.get(id);
      const nextMeaning = {
        type: rawAction.type,
        title,
        description: rawAction.description?.trim() || null,
        ownerId: rawAction.ownerId,
        dueAt: rawAction.dueAt.toISOString(),
      };
      const preserveCompletion = Boolean(existing && !actionMeaningChanged(existing, nextMeaning));
      actions.push({
        id,
        ...nextMeaning,
        status: preserveCompletion ? existing!.status : "OPEN",
        completionNote: preserveCompletion ? existing!.completionNote : null,
        completedById: preserveCompletion ? existing!.completedById : null,
        completedAt: preserveCompletion ? existing!.completedAt : null,
      });
    }

    const now = new Date().toISOString();
    const snapshot: CapaSnapshot = {
      eventId: input.eventId,
      organizationId: input.organizationId,
      siteId: input.siteId,
      status: "DRAFT",
      planSummary: input.planSummary.trim(),
      actions,
      approvedById: null,
      approvedAt: null,
      effectivenessChecks: previous?.effectivenessChecks ?? [],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      closedAt: null,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: previous ? "PLAN_UPDATED" : "CREATED",
      previous,
    });
    return snapshot;
  });
}

export async function approveCapa(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireCapaContext(tx, input);
    const previous = await latestCapaSnapshot(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new CapaError("CAPA_NOT_FOUND", "CAPA plan not found in site scope");
    }
    if (previous.status === "CLOSED") return previous;
    if (previous.status !== "DRAFT") {
      throw new CapaError("CAPA_LOCKED", "Only draft CAPA can be approved");
    }
    if (!previous.planSummary.trim() || previous.actions.length === 0) {
      throw new CapaError("ACTION_REQUIRED", "CAPA approval requires a plan summary and at least one action");
    }
    for (const action of previous.actions) {
      await validateActionOwner(tx, {
        organizationId: input.organizationId,
        siteId: input.siteId,
        ownerId: action.ownerId,
      });
    }

    const now = new Date().toISOString();
    const snapshot: CapaSnapshot = {
      ...previous,
      status: "ACTIVE",
      approvedById: input.actorId,
      approvedAt: now,
      updatedAt: now,
      closedAt: null,
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "APPROVED", previous });
    return snapshot;
  });
}

export async function completeCapaAction(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actionId: string;
  completionNote: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireCapaContext(tx, input);
    const previous = await latestCapaSnapshot(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new CapaError("CAPA_NOT_FOUND", "CAPA plan not found in site scope");
    }
    if (previous.status !== "ACTIVE") {
      throw new CapaError("CAPA_LOCKED", "CAPA actions can only be completed after plan approval");
    }
    const index = previous.actions.findIndex((action) => action.id === input.actionId);
    if (index < 0) throw new CapaError("ACTION_NOT_FOUND", "CAPA action not found");
    if (previous.actions[index].status === "COMPLETED") return previous;
    const note = input.completionNote.trim();
    if (!note) {
      throw new CapaError(
        "ACTION_COMPLETION_NOTE_REQUIRED",
        "A completion note is required to close a CAPA action",
      );
    }

    const now = new Date().toISOString();
    const actions = previous.actions.map((action, actionIndex) =>
      actionIndex === index
        ? {
            ...action,
            status: "COMPLETED" as const,
            completionNote: note,
            completedById: input.actorId,
            completedAt: now,
          }
        : action,
    );
    const snapshot: CapaSnapshot = { ...previous, actions, updatedAt: now };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: "ACTION_COMPLETED",
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
  note: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireCapaContext(tx, input);
    const previous = await latestCapaSnapshot(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new CapaError("CAPA_NOT_FOUND", "CAPA plan not found in site scope");
    }
    if (previous.status !== "ACTIVE") {
      throw new CapaError("CAPA_LOCKED", "Only active CAPA can be verified");
    }
    if (previous.actions.some((action) => action.status !== "COMPLETED")) {
      throw new CapaError("ACTIONS_INCOMPLETE", "Complete every CAPA action before effectiveness verification");
    }
    const note = input.note.trim();
    if (!note) {
      throw new CapaError(
        "EFFECTIVENESS_NOTE_REQUIRED",
        "Effectiveness verification requires an evidence-based note",
      );
    }

    const now = new Date().toISOString();
    const effectivenessChecks = [
      ...previous.effectivenessChecks,
      { result: input.result, note, verifiedById: input.actorId, verifiedAt: now },
    ];
    const snapshot: CapaSnapshot =
      input.result === "EFFECTIVE"
        ? {
            ...previous,
            status: "CLOSED",
            effectivenessChecks,
            updatedAt: now,
            closedAt: now,
          }
        : {
            ...previous,
            status: "DRAFT",
            approvedById: null,
            approvedAt: null,
            effectivenessChecks,
            updatedAt: now,
            closedAt: null,
          };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: input.result === "EFFECTIVE" ? "EFFECTIVENESS_CONFIRMED" : "EFFECTIVENESS_FAILED",
      previous,
    });
    return snapshot;
  });
}

export async function reopenCapa(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireCapaContext(tx, input);
    const previous = await latestCapaSnapshot(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new CapaError("CAPA_NOT_FOUND", "CAPA plan not found in site scope");
    }
    if (previous.status !== "CLOSED") {
      throw new CapaError("CAPA_ALREADY_CLOSED", "Only closed CAPA can be reopened");
    }
    const snapshot: CapaSnapshot = {
      ...previous,
      status: "DRAFT",
      approvedById: null,
      approvedAt: null,
      updatedAt: new Date().toISOString(),
      closedAt: null,
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "REOPENED", previous });
    return snapshot;
  });
}

export async function getCapaWorkspace(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const [event, rootCause, capa] = await Promise.all([
    currentQualityEvent(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId),
    currentRootCause(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId),
    latestCapaSnapshot(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId),
  ]);
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    return null;
  }
  if (capa && (capa.organizationId !== input.organizationId || capa.siteId !== input.siteId)) {
    return null;
  }
  return { event, rootCause, capa };
}

export async function listCapaTimeline(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const workspace = await getCapaWorkspace(input);
  if (!workspace) return null;
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
