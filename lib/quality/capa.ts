import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const ENTITY_TYPE = "QualityCapa";
const QUALITY_EVENT_ENTITY_TYPE = "QualityEvent";
const ROOT_CAUSE_ENTITY_TYPE = "QualityRootCause";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type CapaStatus = "DRAFT" | "ACTIVE" | "EFFECTIVENESS_REVIEW" | "CLOSED";
export type CapaActionType = "CORRECTIVE" | "PREVENTIVE";
export type CapaActionStatus = "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
export type EffectivenessResult = "PENDING" | "EFFECTIVE" | "INEFFECTIVE";

export type CapaActionSnapshot = {
  id: string;
  type: CapaActionType;
  title: string;
  description: string | null;
  ownerId: string;
  ownerName: string;
  dueAt: string;
  status: CapaActionStatus;
  completionEvidence: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CapaEffectivenessSnapshot = {
  method: string;
  ownerId: string;
  ownerName: string;
  dueAt: string;
  result: EffectivenessResult;
  evidence: string | null;
  verifiedAt: string | null;
  verifiedById: string | null;
};

export type CapaSnapshot = {
  eventId: string;
  organizationId: string;
  siteId: string;
  status: CapaStatus;
  objective: string;
  actions: CapaActionSnapshot[];
  effectiveness: CapaEffectivenessSnapshot | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
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
      | "ROOT_CAUSE_CONFIRMATION_REQUIRED"
      | "CAPA_NOT_FOUND"
      | "CAPA_CLOSED"
      | "CAPA_NOT_DRAFT"
      | "CAPA_NOT_ACTIVE"
      | "CAPA_NOT_IN_EFFECTIVENESS_REVIEW"
      | "ACTIONS_REQUIRED"
      | "ACTIONS_INCOMPLETE"
      | "ACTION_NOT_FOUND"
      | "ACTION_OWNER_NOT_FOUND"
      | "INVALID_ACTION"
      | "ACTION_EVIDENCE_REQUIRED"
      | "EFFECTIVENESS_OWNER_NOT_FOUND"
      | "EFFECTIVENESS_EVIDENCE_REQUIRED"
      | "FOLLOW_UP_ACTION_REQUIRED",
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
        parsed.status !== "EFFECTIVENESS_REVIEW" &&
        parsed.status !== "CLOSED") ||
      typeof parsed.objective !== "string" ||
      !Array.isArray(parsed.actions) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !(parsed.activatedAt === null || typeof parsed.activatedAt === "string") ||
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

async function latestEvent(
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

async function latestRootCause(
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

async function latestCapa(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  const log = await client.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseCapa(log?.afterJson ?? null);
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

async function requireInvestigatingEvent(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const event = await latestEvent(tx, input.eventId);
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    throw new CapaError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  if (event.status === "CLOSED") {
    throw new CapaError("EVENT_CLOSED", "Closed quality events cannot change CAPA");
  }
  if (event.status !== "INVESTIGATING") {
    throw new CapaError(
      "INVESTIGATION_REQUIRED",
      "Start the quality-event investigation before editing CAPA",
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
    rootCause.status !== "CONFIRMED"
  ) {
    throw new CapaError(
      "ROOT_CAUSE_CONFIRMATION_REQUIRED",
      "Confirm root-cause analysis before activating CAPA",
    );
  }
}

async function activeOwners(
  tx: Prisma.TransactionClient,
  organizationId: string,
  ownerIds: string[],
) {
  const uniqueOwnerIds = [...new Set(ownerIds)];
  if (uniqueOwnerIds.length === 0) return new Map<string, string>();
  const memberships = await tx.organizationMembership.findMany({
    where: {
      organizationId,
      userId: { in: uniqueOwnerIds },
      active: true,
      user: { active: true },
    },
    select: { userId: true, user: { select: { displayName: true } } },
  });
  return new Map(memberships.map((membership) => [membership.userId, membership.user.displayName]));
}

function actionLocked(action: CapaActionSnapshot) {
  return action.status === "COMPLETED" || action.status === "CANCELLED";
}

export async function saveCapaWorkspace(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  objective: string;
  actions: Array<{
    id: string;
    type: CapaActionType;
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
    if (previous?.status === "CLOSED") {
      throw new CapaError("CAPA_CLOSED", "Closed CAPA is immutable");
    }
    if (previous?.status === "EFFECTIVENESS_REVIEW") {
      throw new CapaError(
        "CAPA_NOT_ACTIVE",
        "CAPA actions cannot be edited during effectiveness review",
      );
    }

    const ids = input.actions.map((action) => action.id);
    if (new Set(ids).size !== ids.length) {
      throw new CapaError("INVALID_ACTION", "CAPA action IDs must be unique");
    }
    const previousById = new Map(previous?.actions.map((action) => [action.id, action]) ?? []);
    for (const prior of previous?.actions ?? []) {
      if (!ids.includes(prior.id)) {
        throw new CapaError(
          "INVALID_ACTION",
          "Existing CAPA actions must be cancelled explicitly instead of deleted",
        );
      }
    }

    const owners = await activeOwners(
      tx,
      input.organizationId,
      input.actions.map((action) => action.ownerId),
    );
    const now = new Date().toISOString();
    const actions: CapaActionSnapshot[] = input.actions.map((action) => {
      const ownerName = owners.get(action.ownerId);
      if (!ownerName) {
        throw new CapaError(
          "ACTION_OWNER_NOT_FOUND",
          "Every CAPA action owner must be an active organization member",
        );
      }
      if (!action.title.trim() || Number.isNaN(action.dueAt.getTime())) {
        throw new CapaError("INVALID_ACTION", "CAPA actions require a title and valid due date");
      }
      const prior = previousById.get(action.id);
      if (
        prior &&
        actionLocked(prior) &&
        (prior.type !== action.type ||
          prior.title !== action.title.trim() ||
          prior.description !== (action.description?.trim() || null) ||
          prior.ownerId !== action.ownerId ||
          prior.dueAt !== action.dueAt.toISOString())
      ) {
        throw new CapaError(
          "INVALID_ACTION",
          "Completed or cancelled CAPA action definitions are immutable",
        );
      }
      return {
        id: action.id,
        type: action.type,
        title: action.title.trim(),
        description: action.description?.trim() || null,
        ownerId: action.ownerId,
        ownerName,
        dueAt: action.dueAt.toISOString(),
        status: prior?.status ?? "OPEN",
        completionEvidence: prior?.completionEvidence ?? null,
        completedAt: prior?.completedAt ?? null,
        createdAt: prior?.createdAt ?? now,
        updatedAt:
          prior &&
          prior.type === action.type &&
          prior.title === action.title.trim() &&
          prior.description === (action.description?.trim() || null) &&
          prior.ownerId === action.ownerId &&
          prior.dueAt === action.dueAt.toISOString()
            ? prior.updatedAt
            : now,
      };
    });

    const snapshot: CapaSnapshot = {
      eventId: input.eventId,
      organizationId: input.organizationId,
      siteId: input.siteId,
      status: previous?.status ?? "DRAFT",
      objective: input.objective.trim(),
      actions,
      effectiveness: previous?.effectiveness ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      activatedAt: previous?.activatedAt ?? null,
      closedAt: null,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: previous ? "UPDATED" : "CREATED",
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
      throw new CapaError("CAPA_NOT_FOUND", "CAPA workspace not found");
    }
    if (previous.status !== "DRAFT") {
      throw new CapaError("CAPA_NOT_DRAFT", "Only draft CAPA can be activated");
    }
    if (!previous.objective.trim() || previous.actions.length === 0) {
      throw new CapaError(
        "ACTIONS_REQUIRED",
        "CAPA requires an objective and at least one corrective or preventive action",
      );
    }
    const now = new Date().toISOString();
    const snapshot: CapaSnapshot = {
      ...previous,
      status: "ACTIVE",
      updatedAt: now,
      activatedAt: now,
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "ACTIVATED", previous });
    return snapshot;
  });
}

export async function transitionCapaAction(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actionId: string;
  status: "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  evidence?: string | null;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new CapaError("CAPA_NOT_FOUND", "CAPA workspace not found");
    }
    if (previous.status !== "ACTIVE") {
      throw new CapaError("CAPA_NOT_ACTIVE", "CAPA actions can only transition while CAPA is active");
    }
    const action = previous.actions.find((candidate) => candidate.id === input.actionId);
    if (!action) throw new CapaError("ACTION_NOT_FOUND", "CAPA action not found");
    if (action.status === "COMPLETED" || action.status === "CANCELLED") {
      throw new CapaError("INVALID_ACTION", "Completed or cancelled CAPA actions are immutable");
    }
    const evidence = input.evidence?.trim() || null;
    if ((input.status === "COMPLETED" || input.status === "CANCELLED") && !evidence) {
      throw new CapaError(
        "ACTION_EVIDENCE_REQUIRED",
        "Completion evidence or cancellation rationale is required",
      );
    }
    if (input.status === "IN_PROGRESS" && action.status !== "OPEN") {
      throw new CapaError("INVALID_ACTION", "Only open CAPA actions can move to in progress");
    }

    const now = new Date().toISOString();
    const nextAction: CapaActionSnapshot = {
      ...action,
      status: input.status,
      completionEvidence: evidence,
      completedAt: input.status === "COMPLETED" ? now : null,
      updatedAt: now,
    };
    const snapshot: CapaSnapshot = {
      ...previous,
      actions: previous.actions.map((candidate) =>
        candidate.id === input.actionId ? nextAction : candidate,
      ),
      updatedAt: now,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action:
        input.status === "IN_PROGRESS"
          ? "ACTION_STARTED"
          : input.status === "COMPLETED"
            ? "ACTION_COMPLETED"
            : "ACTION_CANCELLED",
      previous,
    });
    return snapshot;
  });
}

export async function submitEffectivenessReview(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  method: string;
  ownerId: string;
  dueAt: Date;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new CapaError("CAPA_NOT_FOUND", "CAPA workspace not found");
    }
    if (previous.status !== "ACTIVE") {
      throw new CapaError(
        "CAPA_NOT_ACTIVE",
        "Only active CAPA can enter effectiveness review",
      );
    }
    if (
      previous.actions.length === 0 ||
      previous.actions.some((action) => action.status === "OPEN" || action.status === "IN_PROGRESS") ||
      !previous.actions.some((action) => action.status === "COMPLETED")
    ) {
      throw new CapaError(
        "ACTIONS_INCOMPLETE",
        "Complete or cancel every action, with at least one completed action, before effectiveness review",
      );
    }
    if (!input.method.trim() || Number.isNaN(input.dueAt.getTime())) {
      throw new CapaError(
        "EFFECTIVENESS_EVIDENCE_REQUIRED",
        "Effectiveness review requires a method and valid due date",
      );
    }
    const owners = await activeOwners(tx, input.organizationId, [input.ownerId]);
    const ownerName = owners.get(input.ownerId);
    if (!ownerName) {
      throw new CapaError(
        "EFFECTIVENESS_OWNER_NOT_FOUND",
        "Effectiveness owner must be an active organization member",
      );
    }
    const priorIneffectiveAt =
      previous.effectiveness?.result === "INEFFECTIVE" ? previous.effectiveness.verifiedAt : null;
    if (
      priorIneffectiveAt &&
      !previous.actions.some(
        (action) => action.createdAt > priorIneffectiveAt || action.updatedAt > priorIneffectiveAt,
      )
    ) {
      throw new CapaError(
        "FOLLOW_UP_ACTION_REQUIRED",
        "Add or update a CAPA action after an ineffective verification before resubmitting",
      );
    }

    const now = new Date().toISOString();
    const snapshot: CapaSnapshot = {
      ...previous,
      status: "EFFECTIVENESS_REVIEW",
      effectiveness: {
        method: input.method.trim(),
        ownerId: input.ownerId,
        ownerName,
        dueAt: input.dueAt.toISOString(),
        result: "PENDING",
        evidence: null,
        verifiedAt: null,
        verifiedById: null,
      },
      updatedAt: now,
    };
    await appendSnapshot(tx, snapshot, {
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
  result: "EFFECTIVE" | "INEFFECTIVE";
  evidence: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestCapa(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new CapaError("CAPA_NOT_FOUND", "CAPA workspace not found");
    }
    if (previous.status !== "EFFECTIVENESS_REVIEW" || !previous.effectiveness) {
      throw new CapaError(
        "CAPA_NOT_IN_EFFECTIVENESS_REVIEW",
        "CAPA is not awaiting effectiveness verification",
      );
    }
    const evidence = input.evidence.trim();
    if (!evidence) {
      throw new CapaError(
        "EFFECTIVENESS_EVIDENCE_REQUIRED",
        "Effectiveness verification requires evidence",
      );
    }
    const now = new Date().toISOString();
    const snapshot: CapaSnapshot = {
      ...previous,
      status: input.result === "EFFECTIVE" ? "CLOSED" : "ACTIVE",
      effectiveness: {
        ...previous.effectiveness,
        result: input.result,
        evidence,
        verifiedAt: now,
        verifiedById: input.actorId,
      },
      updatedAt: now,
      closedAt: input.result === "EFFECTIVE" ? now : null,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: input.result === "EFFECTIVE" ? "EFFECTIVENESS_CONFIRMED" : "EFFECTIVENESS_FAILED",
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
  const [event, rootCause, capa] = await Promise.all([
    latestEvent(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId),
    latestRootCause(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId),
    latestCapa(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId),
  ]);
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    return null;
  }
  if (capa && (capa.organizationId !== input.organizationId || capa.siteId !== input.siteId)) {
    return null;
  }
  const rootCauseConfirmed =
    Boolean(rootCause) &&
    rootCause?.organizationId === input.organizationId &&
    rootCause.siteId === input.siteId &&
    rootCause.status === "CONFIRMED";
  return { event, rootCauseConfirmed, capa };
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
    after: parseCapa(log.afterJson),
  }));
}

export async function assertCapaClosureReady(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const capa = await latestCapa(tx, input.eventId);
  if (!capa) return;
  if (
    capa.organizationId !== input.organizationId ||
    capa.siteId !== input.siteId ||
    capa.status !== "CLOSED"
  ) {
    throw new CapaError(
      "ACTIONS_INCOMPLETE",
      "Quality event cannot close while its CAPA is incomplete",
    );
  }
}
