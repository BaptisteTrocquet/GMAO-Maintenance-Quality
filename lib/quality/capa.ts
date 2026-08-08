import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const CAPA_ENTITY_TYPE = "QualityCapa";
const EVENT_ENTITY_TYPE = "QualityEvent";
const ROOT_CAUSE_ENTITY_TYPE = "QualityRootCause";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type CapaStatus = "DRAFT" | "ACTIVE" | "VERIFYING" | "EFFECTIVE" | "INEFFECTIVE";
export type CapaActionType = "CORRECTIVE" | "PREVENTIVE";
export type CapaActionStatus = "OPEN" | "IN_PROGRESS" | "COMPLETED";

export type CapaActionSnapshot = {
  id: string;
  type: CapaActionType;
  title: string;
  description: string | null;
  ownerId: string;
  ownerName: string;
  dueAt: string;
  status: CapaActionStatus;
  completedAt: string | null;
  completionNote: string | null;
};

export type CapaVerificationPlan = {
  method: string;
  acceptanceCriteria: string;
};

export type CapaEffectivenessSnapshot = {
  result: string;
  effective: boolean;
  verifiedById: string;
  verifiedByName: string;
  verifiedAt: string;
};

export type QualityCapaSnapshot = {
  eventId: string;
  organizationId: string;
  siteId: string;
  eventNumber: string;
  eventTitle: string;
  rootCauseSummary: string;
  status: CapaStatus;
  actions: CapaActionSnapshot[];
  verificationPlan: CapaVerificationPlan;
  effectiveness: CapaEffectivenessSnapshot | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  verificationStartedAt: string | null;
};

type QualityEventReference = {
  organizationId: string;
  siteId: string;
  eventNumber: string;
  title: string;
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
};

type RootCauseReference = {
  organizationId: string;
  siteId: string;
  status: "DRAFT" | "CONFIRMED";
  rootCauseSummary: string | null;
};

export class QualityCapaError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "INVESTIGATION_REQUIRED"
      | "EVENT_CLOSED"
      | "ROOT_CAUSE_REQUIRED"
      | "CAPA_NOT_FOUND"
      | "CAPA_NOT_EDITABLE"
      | "CAPA_ACTION_REQUIRED"
      | "CAPA_ACTION_NOT_FOUND"
      | "CAPA_ACTION_OWNER_NOT_FOUND"
      | "INVALID_DUE_DATE"
      | "INVALID_ACTION_TRANSITION"
      | "ACTIONS_INCOMPLETE"
      | "VERIFICATION_PLAN_REQUIRED"
      | "CAPA_NOT_VERIFYING"
      | "INEFFECTIVE_CAPA_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "QualityCapaError";
  }
}

function parseEvent(value: string | null): QualityEventReference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualityEventReference>;
    if (
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
      (parsed.status !== "DRAFT" && parsed.status !== "CONFIRMED") ||
      !(parsed.rootCauseSummary === null || typeof parsed.rootCauseSummary === "string")
    ) {
      return null;
    }
    return parsed as RootCauseReference;
  } catch {
    return null;
  }
}

function isCapaStatus(value: unknown): value is CapaStatus {
  return (
    value === "DRAFT" ||
    value === "ACTIVE" ||
    value === "VERIFYING" ||
    value === "EFFECTIVE" ||
    value === "INEFFECTIVE"
  );
}

function isActionType(value: unknown): value is CapaActionType {
  return value === "CORRECTIVE" || value === "PREVENTIVE";
}

function isActionStatus(value: unknown): value is CapaActionStatus {
  return value === "OPEN" || value === "IN_PROGRESS" || value === "COMPLETED";
}

function parseSnapshot(value: string | null): QualityCapaSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualityCapaSnapshot>;
    if (
      typeof parsed.eventId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.eventNumber !== "string" ||
      typeof parsed.eventTitle !== "string" ||
      typeof parsed.rootCauseSummary !== "string" ||
      !isCapaStatus(parsed.status) ||
      !Array.isArray(parsed.actions) ||
      !parsed.verificationPlan ||
      typeof parsed.verificationPlan.method !== "string" ||
      typeof parsed.verificationPlan.acceptanceCriteria !== "string" ||
      !(parsed.effectiveness === null || typeof parsed.effectiveness === "object") ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !(parsed.activatedAt === null || typeof parsed.activatedAt === "string") ||
      !(parsed.verificationStartedAt === null || typeof parsed.verificationStartedAt === "string")
    ) {
      return null;
    }

    for (const action of parsed.actions) {
      if (
        !action ||
        typeof action !== "object" ||
        typeof action.id !== "string" ||
        !isActionType(action.type) ||
        typeof action.title !== "string" ||
        !(action.description === null || typeof action.description === "string") ||
        typeof action.ownerId !== "string" ||
        typeof action.ownerName !== "string" ||
        typeof action.dueAt !== "string" ||
        !isActionStatus(action.status) ||
        !(action.completedAt === null || typeof action.completedAt === "string") ||
        !(action.completionNote === null || typeof action.completionNote === "string")
      ) {
        return null;
      }
    }

    if (parsed.effectiveness) {
      const effectiveness = parsed.effectiveness as Partial<CapaEffectivenessSnapshot>;
      if (
        typeof effectiveness.result !== "string" ||
        typeof effectiveness.effective !== "boolean" ||
        typeof effectiveness.verifiedById !== "string" ||
        typeof effectiveness.verifiedByName !== "string" ||
        typeof effectiveness.verifiedAt !== "string"
      ) {
        return null;
      }
    }
    return parsed as QualityCapaSnapshot;
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

async function latestEvent(client: Pick<Prisma.TransactionClient, "auditLog">, eventId: string) {
  const log = await client.auditLog.findFirst({
    where: { entityType: EVENT_ENTITY_TYPE, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseEvent(log?.afterJson ?? null);
}

async function latestRootCause(client: Pick<Prisma.TransactionClient, "auditLog">, eventId: string) {
  const log = await client.auditLog.findFirst({
    where: { entityType: ROOT_CAUSE_ENTITY_TYPE, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseRootCause(log?.afterJson ?? null);
}

async function latestCapa(client: Pick<Prisma.TransactionClient, "auditLog">, eventId: string) {
  const log = await client.auditLog.findFirst({
    where: { entityType: CAPA_ENTITY_TYPE, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseSnapshot(log?.afterJson ?? null);
}

async function requireInvestigatingEvent(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const event = await latestEvent(tx, input.eventId);
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    throw new QualityCapaError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  if (event.status === "CLOSED") {
    throw new QualityCapaError("EVENT_CLOSED", "Closed quality events cannot change CAPA");
  }
  if (event.status !== "INVESTIGATING") {
    throw new QualityCapaError(
      "INVESTIGATION_REQUIRED",
      "Start the quality-event investigation before managing CAPA",
    );
  }
  return event;
}

async function requireConfirmedRootCause(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const rootCause = await latestRootCause(tx, input.eventId);
  if (
    !rootCause ||
    rootCause.organizationId !== input.organizationId ||
    rootCause.siteId !== input.siteId ||
    rootCause.status !== "CONFIRMED" ||
    !rootCause.rootCauseSummary?.trim()
  ) {
    throw new QualityCapaError(
      "ROOT_CAUSE_REQUIRED",
      "Confirm root-cause analysis before activating CAPA",
    );
  }
  return rootCause;
}

async function resolveOwner(
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
    select: { user: { select: { id: true, displayName: true } } },
  });
  if (!membership) {
    throw new QualityCapaError(
      "CAPA_ACTION_OWNER_NOT_FOUND",
      "Action owner must be an active organization member with access to the event site",
    );
  }
  return membership.user;
}

function actionId(eventId: string, input: { type: CapaActionType; title: string }, index: number) {
  return createHash("sha256")
    .update(`${eventId}:${input.type}:${input.title.trim().toLowerCase()}:${index}`)
    .digest("hex")
    .slice(0, 24);
}

function validDueAt(value: string) {
  return Boolean(value) && Number.isFinite(new Date(value).getTime());
}

async function normalizeActions(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    siteId: string;
    eventId: string;
    actions: Array<{
      id?: string;
      type: CapaActionType;
      title: string;
      description?: string | null;
      ownerId: string;
      dueAt: string;
    }>;
    previous?: QualityCapaSnapshot | null;
  },
) {
  const previousById = new Map((input.previous?.actions ?? []).map((action) => [action.id, action]));
  const seen = new Set<string>();
  const actions: CapaActionSnapshot[] = [];

  for (let index = 0; index < input.actions.length; index += 1) {
    const source = input.actions[index];
    const title = source.title.trim();
    if (!title) {
      throw new QualityCapaError("CAPA_ACTION_REQUIRED", "Each CAPA action requires a title");
    }
    if (!validDueAt(source.dueAt)) {
      throw new QualityCapaError("INVALID_DUE_DATE", "Each CAPA action requires a valid due date");
    }
    const owner = await resolveOwner(tx, {
      organizationId: input.organizationId,
      siteId: input.siteId,
      ownerId: source.ownerId,
    });
    const id = source.id?.trim() || actionId(input.eventId, source, index);
    if (seen.has(id)) {
      throw new QualityCapaError("CAPA_ACTION_REQUIRED", "CAPA action IDs must be unique");
    }
    seen.add(id);
    const previous = previousById.get(id);
    actions.push({
      id,
      type: source.type,
      title,
      description: source.description?.trim() || null,
      ownerId: owner.id,
      ownerName: owner.displayName,
      dueAt: new Date(source.dueAt).toISOString(),
      status: previous?.status ?? "OPEN",
      completedAt: previous?.completedAt ?? null,
      completionNote: previous?.completionNote ?? null,
    });
  }
  return actions;
}

async function appendSnapshot(
  tx: Prisma.TransactionClient,
  snapshot: QualityCapaSnapshot,
  input: { actorId: string; action: string; previous?: QualityCapaSnapshot | null },
) {
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: CAPA_ENTITY_TYPE,
      entityId: snapshot.eventId,
      action: input.action,
      beforeJson: input.previous ? JSON.stringify(input.previous) : null,
      afterJson: JSON.stringify(snapshot),
    },
  });
}

export async function saveCapaPlan(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actions: Array<{
    id?: string;
    type: CapaActionType;
    title: string;
    description?: string | null;
    ownerId: string;
    dueAt: string;
  }>;
  verificationPlan: CapaVerificationPlan;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const event = await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (previous && previous.status !== "DRAFT" && previous.status !== "ACTIVE") {
      throw new QualityCapaError(
        "CAPA_NOT_EDITABLE",
        "CAPA can only be edited while draft or active",
      );
    }

    const rootCause = await latestRootCause(tx, input.eventId);
    const actions = await normalizeActions(tx, { ...input, previous });
    const now = new Date().toISOString();
    const snapshot: QualityCapaSnapshot = {
      eventId: input.eventId,
      organizationId: input.organizationId,
      siteId: input.siteId,
      eventNumber: previous?.eventNumber ?? event.eventNumber,
      eventTitle: previous?.eventTitle ?? event.title,
      rootCauseSummary:
        previous?.rootCauseSummary ??
        (rootCause?.organizationId === input.organizationId &&
        rootCause.siteId === input.siteId &&
        rootCause.status === "CONFIRMED"
          ? rootCause.rootCauseSummary?.trim() || ""
          : ""),
      status: previous?.status ?? "DRAFT",
      actions,
      verificationPlan: {
        method: input.verificationPlan.method.trim(),
        acceptanceCriteria: input.verificationPlan.acceptanceCriteria.trim(),
      },
      effectiveness: previous?.effectiveness ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      activatedAt: previous?.activatedAt ?? null,
      verificationStartedAt: previous?.verificationStartedAt ?? null,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: previous ? "CAPA_UPDATED" : "CAPA_CREATED",
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
    const rootCause = await requireConfirmedRootCause(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new QualityCapaError("CAPA_NOT_FOUND", "CAPA plan not found");
    }
    if (previous.status !== "DRAFT") {
      throw new QualityCapaError("CAPA_NOT_EDITABLE", "Only draft CAPA can be activated");
    }
    if (previous.actions.length === 0) {
      throw new QualityCapaError("CAPA_ACTION_REQUIRED", "CAPA requires at least one action");
    }

    const now = new Date().toISOString();
    const snapshot: QualityCapaSnapshot = {
      ...previous,
      rootCauseSummary: rootCause.rootCauseSummary!.trim(),
      status: "ACTIVE",
      activatedAt: now,
      updatedAt: now,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: "CAPA_ACTIVATED",
      previous,
    });
    return snapshot;
  });
}

export async function setCapaActionStatus(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actionId: string;
  status: CapaActionStatus;
  completionNote?: string | null;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new QualityCapaError("CAPA_NOT_FOUND", "CAPA plan not found");
    }
    if (previous.status !== "ACTIVE") {
      throw new QualityCapaError("CAPA_NOT_EDITABLE", "Actions can only change while CAPA is active");
    }
    const index = previous.actions.findIndex((action) => action.id === input.actionId);
    if (index < 0) {
      throw new QualityCapaError("CAPA_ACTION_NOT_FOUND", "CAPA action not found");
    }
    const current = previous.actions[index];
    const validTransition =
      current.status === input.status ||
      (current.status === "OPEN" && (input.status === "IN_PROGRESS" || input.status === "COMPLETED")) ||
      (current.status === "IN_PROGRESS" && (input.status === "OPEN" || input.status === "COMPLETED")) ||
      (current.status === "COMPLETED" && input.status === "IN_PROGRESS");
    if (!validTransition) {
      throw new QualityCapaError("INVALID_ACTION_TRANSITION", "Invalid CAPA action status transition");
    }

    const now = new Date().toISOString();
    const actions = [...previous.actions];
    actions[index] = {
      ...current,
      status: input.status,
      completedAt: input.status === "COMPLETED" ? current.completedAt ?? now : null,
      completionNote:
        input.status === "COMPLETED"
          ? input.completionNote?.trim() || current.completionNote
          : null,
    };
    const snapshot: QualityCapaSnapshot = { ...previous, actions, updatedAt: now };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: input.status === "COMPLETED" ? "CAPA_ACTION_COMPLETED" : "CAPA_ACTION_STATUS_CHANGED",
      previous,
    });
    return snapshot;
  });
}

export async function startCapaVerification(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new QualityCapaError("CAPA_NOT_FOUND", "CAPA plan not found");
    }
    if (previous.status !== "ACTIVE") {
      throw new QualityCapaError("CAPA_NOT_EDITABLE", "Only active CAPA can start verification");
    }
    if (previous.actions.length === 0 || previous.actions.some((action) => action.status !== "COMPLETED")) {
      throw new QualityCapaError(
        "ACTIONS_INCOMPLETE",
        "Complete every CAPA action before effectiveness verification",
      );
    }
    if (!previous.verificationPlan.method.trim() || !previous.verificationPlan.acceptanceCriteria.trim()) {
      throw new QualityCapaError(
        "VERIFICATION_PLAN_REQUIRED",
        "Verification method and acceptance criteria are required",
      );
    }
    const now = new Date().toISOString();
    const snapshot: QualityCapaSnapshot = {
      ...previous,
      status: "VERIFYING",
      updatedAt: now,
      verificationStartedAt: now,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: "CAPA_VERIFICATION_STARTED",
      previous,
    });
    return snapshot;
  });
}

export async function verifyCapaEffectiveness(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  effective: boolean;
  result: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new QualityCapaError("CAPA_NOT_FOUND", "CAPA plan not found");
    }
    if (previous.status !== "VERIFYING") {
      throw new QualityCapaError(
        "CAPA_NOT_VERIFYING",
        "CAPA must be in effectiveness verification before recording a result",
      );
    }
    const result = input.result.trim();
    if (!result) {
      throw new QualityCapaError("VERIFICATION_PLAN_REQUIRED", "Effectiveness result is required");
    }
    const verifier = await resolveOwner(tx, {
      organizationId: input.organizationId,
      siteId: input.siteId,
      ownerId: input.actorId,
    });
    const now = new Date().toISOString();
    const snapshot: QualityCapaSnapshot = {
      ...previous,
      status: input.effective ? "EFFECTIVE" : "INEFFECTIVE",
      effectiveness: {
        result,
        effective: input.effective,
        verifiedById: verifier.id,
        verifiedByName: verifier.displayName,
        verifiedAt: now,
      },
      updatedAt: now,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: input.effective ? "CAPA_EFFECTIVE" : "CAPA_INEFFECTIVE",
      previous,
    });
    return snapshot;
  });
}

export async function reopenIneffectiveCapa(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new QualityCapaError("CAPA_NOT_FOUND", "CAPA plan not found");
    }
    if (previous.status !== "INEFFECTIVE") {
      throw new QualityCapaError(
        "INEFFECTIVE_CAPA_REQUIRED",
        "Only an ineffective CAPA can be reopened",
      );
    }
    const snapshot: QualityCapaSnapshot = {
      ...previous,
      status: "ACTIVE",
      effectiveness: null,
      verificationStartedAt: null,
      updatedAt: new Date().toISOString(),
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: "CAPA_REOPENED",
      previous,
    });
    return snapshot;
  });
}

export async function getCapaWorkspace(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const [event, capa] = await Promise.all([
    latestEvent(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId),
    latestCapa(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId),
  ]);
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    return null;
  }
  if (capa && (capa.organizationId !== input.organizationId || capa.siteId !== input.siteId)) {
    return null;
  }
  return { event, capa };
}

export async function listCapaTimeline(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const workspace = await getCapaWorkspace(input);
  if (!workspace) return null;
  const logs = await db.auditLog.findMany({
    where: { entityType: CAPA_ENTITY_TYPE, entityId: input.eventId },
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
