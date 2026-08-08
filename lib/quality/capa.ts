import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const CAPA_ENTITY = "QualityCapa";
const QUALITY_EVENT_ENTITY = "QualityEvent";
const ROOT_CAUSE_ENTITY = "QualityRootCause";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type CapaStatus = "DRAFT" | "ACTIVE" | "READY_FOR_EFFECTIVENESS";
export type QualityActionType = "CORRECTIVE" | "PREVENTIVE";
export type QualityActionStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export type QualityActionSnapshot = {
  id: string;
  actionKey: string;
  type: QualityActionType;
  title: string;
  description: string | null;
  ownerId: string;
  dueAt: string;
  status: QualityActionStatus;
  completionNote: string | null;
  completedAt: string | null;
};

export type CapaSnapshot = {
  eventId: string;
  organizationId: string;
  siteId: string;
  status: CapaStatus;
  objective: string;
  actions: QualityActionSnapshot[];
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  readyForEffectivenessAt: string | null;
};

type QualityEventState = {
  organizationId: string;
  siteId: string;
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
};

type RootCauseState = {
  organizationId: string;
  siteId: string;
  status: "DRAFT" | "CONFIRMED";
};

export class CapaError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "EVENT_NOT_INVESTIGATING"
      | "ROOT_CAUSE_CONFIRMATION_REQUIRED"
      | "CAPA_NOT_FOUND"
      | "CAPA_NOT_DRAFT"
      | "CAPA_NOT_ACTIVE"
      | "ACTION_NOT_FOUND"
      | "ACTION_OWNER_NOT_FOUND"
      | "DUPLICATE_ACTION_KEY"
      | "ACTION_DATA_REQUIRED"
      | "INVALID_ACTION_TRANSITION"
      | "ACTION_COMPLETION_NOTE_REQUIRED"
      | "OPEN_ACTIONS_REMAIN",
    message: string,
  ) {
    super(message);
    this.name = "CapaError";
  }
}

function stableActionId(eventId: string, actionKey: string) {
  return createHash("sha256").update(`${eventId}:${actionKey}`).digest("hex");
}

function parseEvent(value: string | null): QualityEventState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualityEventState>;
    if (
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "OPEN" &&
        parsed.status !== "CONTAINED" &&
        parsed.status !== "INVESTIGATING" &&
        parsed.status !== "CLOSED")
    ) return null;
    return parsed as QualityEventState;
  } catch {
    return null;
  }
}

function parseRootCause(value: string | null): RootCauseState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RootCauseState>;
    if (
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "DRAFT" && parsed.status !== "CONFIRMED")
    ) return null;
    return parsed as RootCauseState;
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
      (parsed.status !== "DRAFT" && parsed.status !== "ACTIVE" && parsed.status !== "READY_FOR_EFFECTIVENESS") ||
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
    throw new CapaError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  if (event.status !== "INVESTIGATING") {
    throw new CapaError("EVENT_NOT_INVESTIGATING", "CAPA can only be changed while the quality event is investigating");
  }
  return event;
}

async function requireConfirmedRootCause(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const rootCause = parseRootCause(await latestJson(tx, ROOT_CAUSE_ENTITY, input.eventId));
  if (
    !rootCause ||
    rootCause.organizationId !== input.organizationId ||
    rootCause.siteId !== input.siteId ||
    rootCause.status !== "CONFIRMED"
  ) {
    throw new CapaError(
      "ROOT_CAUSE_CONFIRMATION_REQUIRED",
      "Confirm root-cause analysis before activating CAPA",
    );
  }
}

async function latestCapa(client: Pick<Prisma.TransactionClient, "auditLog">, eventId: string) {
  return parseCapa(await latestJson(client, CAPA_ENTITY, eventId));
}

async function validateOwners(
  tx: Prisma.TransactionClient,
  organizationId: string,
  siteId: string,
  ownerIds: string[],
) {
  const uniqueOwnerIds = [...new Set(ownerIds)];
  if (!uniqueOwnerIds.length) return;
  const memberships = await tx.organizationMembership.findMany({
    where: {
      organizationId,
      userId: { in: uniqueOwnerIds },
      active: true,
      user: { active: true },
      OR: [{ allSites: true }, { siteMemberships: { some: { siteId } } }],
    },
    select: { userId: true },
  });
  const valid = new Set(memberships.map((membership) => membership.userId));
  const missing = uniqueOwnerIds.find((ownerId) => !valid.has(ownerId));
  if (missing) {
    throw new CapaError(
      "ACTION_OWNER_NOT_FOUND",
      "Each CAPA action owner must be an active organization member with access to this site",
    );
  }
}

function normalizeActions(
  eventId: string,
  actions: Array<{
    actionKey: string;
    type: QualityActionType;
    title: string;
    description?: string | null;
    ownerId: string;
    dueAt: Date;
  }>,
  previous?: CapaSnapshot | null,
) {
  const keys = new Set<string>();
  const previousByKey = new Map((previous?.actions ?? []).map((action) => [action.actionKey, action]));
  return actions.map((input) => {
    const actionKey = input.actionKey.trim();
    if (!actionKey || keys.has(actionKey)) {
      throw new CapaError("DUPLICATE_ACTION_KEY", "CAPA actionKey values must be non-empty and unique");
    }
    keys.add(actionKey);
    if (!input.title.trim() || !input.ownerId.trim() || Number.isNaN(input.dueAt.getTime())) {
      throw new CapaError("ACTION_DATA_REQUIRED", "Each CAPA action requires title, owner and due date");
    }
    const existing = previousByKey.get(actionKey);
    return {
      id: existing?.id ?? stableActionId(eventId, actionKey),
      actionKey,
      type: input.type,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      ownerId: input.ownerId,
      dueAt: input.dueAt.toISOString(),
      status: existing?.status ?? ("PLANNED" as const),
      completionNote: existing?.completionNote ?? null,
      completedAt: existing?.completedAt ?? null,
    } satisfies QualityActionSnapshot;
  });
}

async function appendSnapshot(
  tx: Prisma.TransactionClient,
  snapshot: CapaSnapshot,
  input: { actorId: string; action: string; previous?: CapaSnapshot | null },
) {
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: CAPA_ENTITY,
      entityId: snapshot.eventId,
      action: input.action,
      beforeJson: input.previous ? JSON.stringify(input.previous) : null,
      afterJson: JSON.stringify(snapshot),
    },
  });
}

export async function saveCapaDraft(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  objective: string;
  actions: Array<{
    actionKey: string;
    type: QualityActionType;
    title: string;
    description?: string | null;
    ownerId: string;
    dueAt: Date;
  }>;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (previous?.status !== undefined && previous.status !== "DRAFT") {
      throw new CapaError("CAPA_NOT_DRAFT", "Only draft CAPA plans can change plan structure");
    }
    const actions = normalizeActions(input.eventId, input.actions, previous);
    await validateOwners(tx, input.organizationId, input.siteId, actions.map((action) => action.ownerId));
    const now = new Date().toISOString();
    const snapshot: CapaSnapshot = {
      eventId: input.eventId,
      organizationId: input.organizationId,
      siteId: input.siteId,
      status: "DRAFT",
      objective: input.objective.trim(),
      actions,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      activatedAt: null,
      readyForEffectivenessAt: null,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: previous ? "CAPA_DRAFT_UPDATED" : "CAPA_DRAFT_CREATED",
      previous,
    });
    return snapshot;
  });
}

export async function activateCapa(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    await requireConfirmedRootCause(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new CapaError("CAPA_NOT_FOUND", "CAPA plan not found in site scope");
    }
    if (previous.status !== "DRAFT") throw new CapaError("CAPA_NOT_DRAFT", "Only draft CAPA can be activated");
    if (!previous.objective.trim() || previous.actions.length === 0) {
      throw new CapaError("ACTION_DATA_REQUIRED", "CAPA activation requires an objective and at least one action");
    }
    await validateOwners(tx, input.organizationId, input.siteId, previous.actions.map((action) => action.ownerId));
    const now = new Date().toISOString();
    const snapshot: CapaSnapshot = {
      ...previous,
      status: "ACTIVE",
      updatedAt: now,
      activatedAt: now,
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "CAPA_ACTIVATED", previous });
    return snapshot;
  });
}

function transitionAction(
  action: QualityActionSnapshot,
  transition: "START" | "COMPLETE" | "CANCEL",
  completionNote?: string | null,
) {
  if (transition === "START" && action.status === "PLANNED") {
    return { ...action, status: "IN_PROGRESS" as const };
  }
  if (transition === "COMPLETE" && (action.status === "PLANNED" || action.status === "IN_PROGRESS")) {
    const note = completionNote?.trim();
    if (!note) {
      throw new CapaError("ACTION_COMPLETION_NOTE_REQUIRED", "A completion note is required when completing a CAPA action");
    }
    return {
      ...action,
      status: "COMPLETED" as const,
      completionNote: note,
      completedAt: new Date().toISOString(),
    };
  }
  if (transition === "CANCEL" && (action.status === "PLANNED" || action.status === "IN_PROGRESS")) {
    return { ...action, status: "CANCELLED" as const, completionNote: completionNote?.trim() || null };
  }
  throw new CapaError("INVALID_ACTION_TRANSITION", "Unsupported CAPA action status transition");
}

function actionAuditName(transition: "START" | "COMPLETE" | "CANCEL") {
  if (transition === "START") return "CAPA_ACTION_STARTED";
  if (transition === "COMPLETE") return "CAPA_ACTION_COMPLETED";
  return "CAPA_ACTION_CANCELLED";
}

export async function transitionCapaAction(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actionId: string;
  transition: "START" | "COMPLETE" | "CANCEL";
  completionNote?: string | null;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new CapaError("CAPA_NOT_FOUND", "CAPA plan not found in site scope");
    }
    if (previous.status !== "ACTIVE") throw new CapaError("CAPA_NOT_ACTIVE", "CAPA actions can only execute while CAPA is active");
    const index = previous.actions.findIndex((action) => action.id === input.actionId);
    if (index < 0) throw new CapaError("ACTION_NOT_FOUND", "CAPA action not found");
    const updatedAction = transitionAction(previous.actions[index], input.transition, input.completionNote);
    const actions = previous.actions.map((action, actionIndex) => actionIndex === index ? updatedAction : action);
    const snapshot: CapaSnapshot = { ...previous, actions, updatedAt: new Date().toISOString() };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: actionAuditName(input.transition),
      previous,
    });
    return snapshot;
  });
}

export async function markCapaReadyForEffectiveness(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new CapaError("CAPA_NOT_FOUND", "CAPA plan not found in site scope");
    }
    if (previous.status !== "ACTIVE") throw new CapaError("CAPA_NOT_ACTIVE", "Only active CAPA can move to effectiveness verification");
    if (previous.actions.some((action) => action.status !== "COMPLETED" && action.status !== "CANCELLED")) {
      throw new CapaError("OPEN_ACTIONS_REMAIN", "Complete or cancel every CAPA action before effectiveness verification");
    }
    const now = new Date().toISOString();
    const snapshot: CapaSnapshot = {
      ...previous,
      status: "READY_FOR_EFFECTIVENESS",
      updatedAt: now,
      readyForEffectivenessAt: now,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: "CAPA_READY_FOR_EFFECTIVENESS",
      previous,
    });
    return snapshot;
  });
}

export async function getCapa(input: { organizationId: string; siteId: string; eventId: string }) {
  const event = parseEvent(
    await latestJson(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, QUALITY_EVENT_ENTITY, input.eventId),
  );
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) return null;
  const capa = await latestCapa(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId);
  if (capa && (capa.organizationId !== input.organizationId || capa.siteId !== input.siteId)) return null;
  return { event, capa };
}

export async function listCapaTimeline(input: { organizationId: string; siteId: string; eventId: string }) {
  const scoped = await getCapa(input);
  if (!scoped) return null;
  const records = await db.auditLog.findMany({
    where: { entityType: CAPA_ENTITY, entityId: input.eventId },
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
  return records.flatMap((record) => {
    const after = parseCapa(record.afterJson);
    if (!after || after.organizationId !== input.organizationId || after.siteId !== input.siteId) return [];
    return [{ id: record.id, action: record.action, createdAt: record.createdAt, actorName: record.actor?.displayName ?? "System", after }];
  });
}
