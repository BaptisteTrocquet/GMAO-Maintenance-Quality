import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const ENTITY_TYPE = "QualityEightD";
const EVENT_ENTITY_TYPE = "QualityEvent";
const ROOT_CAUSE_ENTITY_TYPE = "QualityRootCause";
const CAPA_ENTITY_TYPE = "QualityCapa";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type EightDDiscipline = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8";
export type EightDStatus = "DRAFT" | "IN_PROGRESS" | "COMPLETED";

export type EightDTeamMember = {
  userId: string;
  displayName: string;
  responsibility: string;
};

export type EightDActionReference = {
  id: string;
  type: "CORRECTIVE" | "PREVENTIVE";
  title: string;
  ownerId: string;
  ownerName: string;
  dueAt: string;
};

export type EightDSnapshot = {
  eventId: string;
  organizationId: string;
  siteId: string;
  eventNumber: string;
  eventTitle: string;
  status: EightDStatus;
  currentDiscipline: EightDDiscipline;
  d1Team: EightDTeamMember[];
  d2ProblemStatement: string;
  d3Containment: { summary: string; completedAt: string } | null;
  d4RootCause: { summary: string; confirmedAt: string } | null;
  d5Actions: EightDActionReference[];
  d6Implementation: {
    completedActionIds: string[];
    verificationMethod: string;
    acceptanceCriteria: string;
    verificationStartedAt: string;
  } | null;
  d7PreventionSummary: string;
  d7SystemicChanges: string[];
  d8RecognitionNote: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type EventReference = {
  organizationId: string;
  siteId: string;
  eventNumber: string;
  title: string;
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
  containment: { summary: string; completedAt: string | null } | null;
};

type RootCauseReference = {
  organizationId: string;
  siteId: string;
  status: "DRAFT" | "CONFIRMED";
  rootCauseSummary: string | null;
  confirmedAt: string | null;
};

type CapaReference = {
  organizationId: string;
  siteId: string;
  status: "DRAFT" | "ACTIVE" | "VERIFYING" | "EFFECTIVE" | "INEFFECTIVE";
  actions: Array<{
    id: string;
    type: "CORRECTIVE" | "PREVENTIVE";
    title: string;
    ownerId: string;
    ownerName: string;
    dueAt: string;
    status: "OPEN" | "IN_PROGRESS" | "COMPLETED";
  }>;
  verificationPlan: { method: string; acceptanceCriteria: string };
  verificationStartedAt: string | null;
};

export class EightDError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "INVESTIGATION_REQUIRED"
      | "EVENT_CLOSED"
      | "EIGHT_D_NOT_FOUND"
      | "EIGHT_D_COMPLETED"
      | "TEAM_REQUIRED"
      | "TEAM_MEMBER_NOT_FOUND"
      | "PROBLEM_STATEMENT_REQUIRED"
      | "CONTAINMENT_REQUIRED"
      | "ROOT_CAUSE_REQUIRED"
      | "CAPA_REQUIRED"
      | "CAPA_ACTIONS_INCOMPLETE"
      | "PREVENTION_REQUIRED"
      | "EFFECTIVE_CAPA_REQUIRED"
      | "RECOGNITION_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "EightDError";
  }
}

function parseEvent(value: string | null): EventReference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<EventReference>;
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
    return parsed as EventReference;
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
      !(parsed.rootCauseSummary === null || typeof parsed.rootCauseSummary === "string") ||
      !(parsed.confirmedAt === null || typeof parsed.confirmedAt === "string")
    ) {
      return null;
    }
    return parsed as RootCauseReference;
  } catch {
    return null;
  }
}

function parseCapa(value: string | null): CapaReference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CapaReference>;
    if (
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "DRAFT" &&
        parsed.status !== "ACTIVE" &&
        parsed.status !== "VERIFYING" &&
        parsed.status !== "EFFECTIVE" &&
        parsed.status !== "INEFFECTIVE") ||
      !Array.isArray(parsed.actions) ||
      !parsed.verificationPlan ||
      typeof parsed.verificationPlan.method !== "string" ||
      typeof parsed.verificationPlan.acceptanceCriteria !== "string" ||
      !(parsed.verificationStartedAt === null || typeof parsed.verificationStartedAt === "string")
    ) {
      return null;
    }
    return parsed as CapaReference;
  } catch {
    return null;
  }
}

function isDiscipline(value: unknown): value is EightDDiscipline {
  return value === "D1" || value === "D2" || value === "D3" || value === "D4" || value === "D5" || value === "D6" || value === "D7" || value === "D8";
}

function parseSnapshot(value: string | null): EightDSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<EightDSnapshot>;
    if (
      typeof parsed.eventId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.eventNumber !== "string" ||
      typeof parsed.eventTitle !== "string" ||
      (parsed.status !== "DRAFT" && parsed.status !== "IN_PROGRESS" && parsed.status !== "COMPLETED") ||
      !isDiscipline(parsed.currentDiscipline) ||
      !Array.isArray(parsed.d1Team) ||
      typeof parsed.d2ProblemStatement !== "string" ||
      !Array.isArray(parsed.d5Actions) ||
      typeof parsed.d7PreventionSummary !== "string" ||
      !Array.isArray(parsed.d7SystemicChanges) ||
      typeof parsed.d8RecognitionNote !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !(parsed.completedAt === null || typeof parsed.completedAt === "string")
    ) {
      return null;
    }
    return parsed as EightDSnapshot;
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

async function latestAuditSnapshot<T>(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  entityType: string,
  eventId: string,
  parser: (value: string | null) => T | null,
) {
  const log = await client.auditLog.findFirst({
    where: { entityType, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parser(log?.afterJson ?? null);
}

function latestEvent(client: Pick<Prisma.TransactionClient, "auditLog">, eventId: string) {
  return latestAuditSnapshot(client, EVENT_ENTITY_TYPE, eventId, parseEvent);
}

function latestRootCause(client: Pick<Prisma.TransactionClient, "auditLog">, eventId: string) {
  return latestAuditSnapshot(client, ROOT_CAUSE_ENTITY_TYPE, eventId, parseRootCause);
}

function latestCapa(client: Pick<Prisma.TransactionClient, "auditLog">, eventId: string) {
  return latestAuditSnapshot(client, CAPA_ENTITY_TYPE, eventId, parseCapa);
}

function latestEightD(client: Pick<Prisma.TransactionClient, "auditLog">, eventId: string) {
  return latestAuditSnapshot(client, ENTITY_TYPE, eventId, parseSnapshot);
}

async function requireInvestigatingEvent(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const event = await latestEvent(tx, input.eventId);
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    throw new EightDError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  if (event.status === "CLOSED") {
    throw new EightDError("EVENT_CLOSED", "Closed quality events cannot change 8D");
  }
  if (event.status !== "INVESTIGATING") {
    throw new EightDError("INVESTIGATION_REQUIRED", "Start the quality-event investigation before managing 8D");
  }
  return event;
}

async function resolveTeam(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    siteId: string;
    team: Array<{ userId: string; responsibility: string }>;
  },
) {
  const seen = new Set<string>();
  const team: EightDTeamMember[] = [];
  for (const member of input.team) {
    if (seen.has(member.userId)) continue;
    seen.add(member.userId);
    const membership = await tx.organizationMembership.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: member.userId,
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
      throw new EightDError("TEAM_MEMBER_NOT_FOUND", "8D team members must have active access to the event site");
    }
    team.push({
      userId: membership.user.id,
      displayName: membership.user.displayName,
      responsibility: member.responsibility.trim(),
    });
  }
  return team;
}

async function appendSnapshot(
  tx: Prisma.TransactionClient,
  snapshot: EightDSnapshot,
  input: { actorId: string; action: string; previous?: EightDSnapshot | null },
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

export async function saveEightDWorkspace(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  team?: Array<{ userId: string; responsibility: string }>;
  problemStatement?: string;
  preventionSummary?: string;
  systemicChanges?: string[];
  recognitionNote?: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const event = await requireInvestigatingEvent(tx, input);
    const previous = await latestEightD(tx, input.eventId);
    if (previous?.status === "COMPLETED") {
      throw new EightDError("EIGHT_D_COMPLETED", "Completed 8D records are immutable");
    }

    const team = input.team
      ? await resolveTeam(tx, {
          organizationId: input.organizationId,
          siteId: input.siteId,
          team: input.team,
        })
      : previous?.d1Team ?? [];
    const now = new Date().toISOString();
    const snapshot: EightDSnapshot = {
      eventId: input.eventId,
      organizationId: input.organizationId,
      siteId: input.siteId,
      eventNumber: previous?.eventNumber ?? event.eventNumber,
      eventTitle: previous?.eventTitle ?? event.title,
      status: previous?.status ?? "DRAFT",
      currentDiscipline: previous?.currentDiscipline ?? "D1",
      d1Team: team,
      d2ProblemStatement: input.problemStatement?.trim() ?? previous?.d2ProblemStatement ?? "",
      d3Containment: previous?.d3Containment ?? null,
      d4RootCause: previous?.d4RootCause ?? null,
      d5Actions: previous?.d5Actions ?? [],
      d6Implementation: previous?.d6Implementation ?? null,
      d7PreventionSummary: input.preventionSummary?.trim() ?? previous?.d7PreventionSummary ?? "",
      d7SystemicChanges:
        input.systemicChanges?.map((value) => value.trim()).filter(Boolean) ?? previous?.d7SystemicChanges ?? [],
      d8RecognitionNote: input.recognitionNote?.trim() ?? previous?.d8RecognitionNote ?? "",
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      completedAt: null,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: previous ? "EIGHT_D_UPDATED" : "EIGHT_D_CREATED",
      previous,
    });
    return snapshot;
  });
}

const NEXT_DISCIPLINE: Record<Exclude<EightDDiscipline, "D8">, EightDDiscipline> = {
  D1: "D2",
  D2: "D3",
  D3: "D4",
  D4: "D5",
  D5: "D6",
  D6: "D7",
  D7: "D8",
};

export async function advanceEightD(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const event = await requireInvestigatingEvent(tx, input);
    const previous = await latestEightD(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new EightDError("EIGHT_D_NOT_FOUND", "8D workspace not found");
    }
    if (previous.status === "COMPLETED") return previous;

    const now = new Date().toISOString();
    let snapshot: EightDSnapshot = { ...previous, updatedAt: now };
    const discipline = previous.currentDiscipline;

    switch (discipline) {
      case "D1":
        if (previous.d1Team.length === 0) {
          throw new EightDError("TEAM_REQUIRED", "D1 requires at least one accountable team member");
        }
        snapshot = { ...snapshot, status: "IN_PROGRESS", currentDiscipline: NEXT_DISCIPLINE.D1 };
        break;
      case "D2":
        if (!previous.d2ProblemStatement.trim()) {
          throw new EightDError("PROBLEM_STATEMENT_REQUIRED", "D2 requires a problem statement");
        }
        snapshot = { ...snapshot, currentDiscipline: NEXT_DISCIPLINE.D2 };
        break;
      case "D3":
        if (!event.containment?.summary.trim() || !event.containment.completedAt) {
          throw new EightDError("CONTAINMENT_REQUIRED", "D3 requires completed immediate containment");
        }
        snapshot = {
          ...snapshot,
          d3Containment: {
            summary: event.containment.summary.trim(),
            completedAt: event.containment.completedAt,
          },
          currentDiscipline: NEXT_DISCIPLINE.D3,
        };
        break;
      case "D4": {
        const rootCause = await latestRootCause(tx, input.eventId);
        if (
          !rootCause ||
          rootCause.organizationId !== input.organizationId ||
          rootCause.siteId !== input.siteId ||
          rootCause.status !== "CONFIRMED" ||
          !rootCause.rootCauseSummary?.trim() ||
          !rootCause.confirmedAt
        ) {
          throw new EightDError("ROOT_CAUSE_REQUIRED", "D4 requires confirmed root-cause analysis");
        }
        snapshot = {
          ...snapshot,
          d4RootCause: {
            summary: rootCause.rootCauseSummary.trim(),
            confirmedAt: rootCause.confirmedAt,
          },
          currentDiscipline: NEXT_DISCIPLINE.D4,
        };
        break;
      }
      case "D5": {
        const capa = await latestCapa(tx, input.eventId);
        if (
          !capa ||
          capa.organizationId !== input.organizationId ||
          capa.siteId !== input.siteId ||
          capa.status === "DRAFT" ||
          capa.actions.length === 0
        ) {
          throw new EightDError("CAPA_REQUIRED", "D5 requires an activated CAPA with permanent actions");
        }
        snapshot = {
          ...snapshot,
          d5Actions: capa.actions.map((action) => ({
            id: action.id,
            type: action.type,
            title: action.title,
            ownerId: action.ownerId,
            ownerName: action.ownerName,
            dueAt: action.dueAt,
          })),
          currentDiscipline: NEXT_DISCIPLINE.D5,
        };
        break;
      }
      case "D6": {
        const capa = await latestCapa(tx, input.eventId);
        if (
          !capa ||
          capa.organizationId !== input.organizationId ||
          capa.siteId !== input.siteId ||
          capa.actions.length === 0 ||
          capa.actions.some((action) => action.status !== "COMPLETED") ||
          !capa.verificationStartedAt
        ) {
          throw new EightDError(
            "CAPA_ACTIONS_INCOMPLETE",
            "D6 requires all permanent CAPA actions completed and effectiveness verification started",
          );
        }
        snapshot = {
          ...snapshot,
          d6Implementation: {
            completedActionIds: capa.actions.map((action) => action.id),
            verificationMethod: capa.verificationPlan.method,
            acceptanceCriteria: capa.verificationPlan.acceptanceCriteria,
            verificationStartedAt: capa.verificationStartedAt,
          },
          currentDiscipline: NEXT_DISCIPLINE.D6,
        };
        break;
      }
      case "D7":
        if (!previous.d7PreventionSummary.trim() || previous.d7SystemicChanges.length === 0) {
          throw new EightDError(
            "PREVENTION_REQUIRED",
            "D7 requires a prevention summary and at least one systemic change",
          );
        }
        snapshot = { ...snapshot, currentDiscipline: NEXT_DISCIPLINE.D7 };
        break;
      case "D8": {
        if (!previous.d8RecognitionNote.trim()) {
          throw new EightDError("RECOGNITION_REQUIRED", "D8 requires a closure and team-recognition note");
        }
        const capa = await latestCapa(tx, input.eventId);
        if (
          !capa ||
          capa.organizationId !== input.organizationId ||
          capa.siteId !== input.siteId ||
          capa.status !== "EFFECTIVE"
        ) {
          throw new EightDError("EFFECTIVE_CAPA_REQUIRED", "D8 requires an effective CAPA result");
        }
        snapshot = {
          ...snapshot,
          status: "COMPLETED",
          completedAt: now,
        };
        break;
      }
    }

    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: discipline === "D8" ? "EIGHT_D_COMPLETED" : `${discipline}_COMPLETED`,
      previous,
    });
    return snapshot;
  });
}

export async function getEightDWorkspace(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const [event, eightD] = await Promise.all([
    latestEvent(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId),
    latestEightD(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input.eventId),
  ]);
  if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
    return null;
  }
  if (eightD && (eightD.organizationId !== input.organizationId || eightD.siteId !== input.siteId)) {
    return null;
  }
  return { event, eightD };
}

export async function listEightDTimeline(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const workspace = await getEightDWorkspace(input);
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
