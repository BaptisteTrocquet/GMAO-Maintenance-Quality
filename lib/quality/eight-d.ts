import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const ENTITY_TYPE = "Quality8D";
const QUALITY_EVENT_ENTITY_TYPE = "QualityEvent";
const ROOT_CAUSE_ENTITY_TYPE = "QualityRootCause";
const CAPA_ENTITY_TYPE = "QualityCapa";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type EightDStatus = "DRAFT" | "ACTIVE" | "CLOSED";
export type EightDDisciplineKey = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8";

export type EightDSnapshot = {
  eventId: string;
  organizationId: string;
  siteId: string;
  status: EightDStatus;
  leaderId: string;
  teamMemberIds: string[];
  problemStatement: string;
  preventionSummary: string | null;
  recognitionNote: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  closedById: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type QualityEventReference = {
  organizationId: string;
  siteId: string;
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
  containment: { summary: string; completedAt: string | null } | null;
};

type RootCauseReference = {
  organizationId: string;
  siteId: string;
  status: "DRAFT" | "CONFIRMED";
  rootCauseSummary: string | null;
};

type CapaReference = {
  organizationId: string;
  siteId: string;
  status: "DRAFT" | "ACTIVE" | "CLOSED";
  actions: Array<{ status: "OPEN" | "COMPLETED" }>;
  effectivenessChecks: Array<{ result: "EFFECTIVE" | "INEFFECTIVE" }>;
};

export class EightDError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "EVENT_CLOSED"
      | "EIGHT_D_NOT_FOUND"
      | "EIGHT_D_LOCKED"
      | "EIGHT_D_ALREADY_CLOSED"
      | "TEAM_REQUIRED"
      | "TEAM_MEMBER_NOT_FOUND"
      | "PROBLEM_STATEMENT_REQUIRED"
      | "CONTAINMENT_REQUIRED"
      | "ROOT_CAUSE_REQUIRED"
      | "CAPA_REQUIRED"
      | "PREVENTION_REQUIRED"
      | "RECOGNITION_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "EightDError";
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

function parseCapa(value: string | null): CapaReference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CapaReference>;
    if (
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "DRAFT" && parsed.status !== "ACTIVE" && parsed.status !== "CLOSED") ||
      !Array.isArray(parsed.actions) ||
      !Array.isArray(parsed.effectivenessChecks)
    ) {
      return null;
    }
    return parsed as CapaReference;
  } catch {
    return null;
  }
}

function parseSnapshot(value: string | null): EightDSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<EightDSnapshot>;
    if (
      typeof parsed.eventId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "DRAFT" && parsed.status !== "ACTIVE" && parsed.status !== "CLOSED") ||
      typeof parsed.leaderId !== "string" ||
      !Array.isArray(parsed.teamMemberIds) ||
      typeof parsed.problemStatement !== "string" ||
      !(parsed.preventionSummary === null || typeof parsed.preventionSummary === "string") ||
      !(parsed.recognitionNote === null || typeof parsed.recognitionNote === "string") ||
      !(parsed.approvedById === null || typeof parsed.approvedById === "string") ||
      !(parsed.approvedAt === null || typeof parsed.approvedAt === "string") ||
      !(parsed.closedById === null || typeof parsed.closedById === "string") ||
      !(parsed.closedAt === null || typeof parsed.closedAt === "string") ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string"
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

async function latestJson(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  entityType: string,
  eventId: string,
) {
  const log = await client.auditLog.findFirst({
    where: { entityType, entityId: eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return log?.afterJson ?? null;
}

async function currentContext(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  const [eventJson, rootCauseJson, capaJson, eightDJson] = await Promise.all([
    latestJson(client, QUALITY_EVENT_ENTITY_TYPE, eventId),
    latestJson(client, ROOT_CAUSE_ENTITY_TYPE, eventId),
    latestJson(client, CAPA_ENTITY_TYPE, eventId),
    latestJson(client, ENTITY_TYPE, eventId),
  ]);
  return {
    event: parseQualityEvent(eventJson),
    rootCause: parseRootCause(rootCauseJson),
    capa: parseCapa(capaJson),
    eightD: parseSnapshot(eightDJson),
  };
}

async function requireEvent(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const context = await currentContext(tx, input.eventId);
  if (
    !context.event ||
    context.event.organizationId !== input.organizationId ||
    context.event.siteId !== input.siteId
  ) {
    throw new EightDError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
  }
  if (context.event.status === "CLOSED") {
    throw new EightDError("EVENT_CLOSED", "Closed quality events cannot change 8D");
  }
  return context;
}

async function validateTeamMember(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; userId: string },
) {
  const membership = await tx.organizationMembership.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      active: true,
      user: { active: true },
      OR: [{ allSites: true }, { siteMemberships: { some: { siteId: input.siteId } } }],
    },
    select: { id: true },
  });
  if (!membership) {
    throw new EightDError(
      "TEAM_MEMBER_NOT_FOUND",
      "Every 8D team member must be active and have access to this site",
    );
  }
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

function uniqueTeam(leaderId: string, teamMemberIds: string[]) {
  return [...new Set([leaderId, ...teamMemberIds].map((value) => value.trim()).filter(Boolean))];
}

export async function latestEightDSnapshot(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  return parseSnapshot(await latestJson(client, ENTITY_TYPE, eventId));
}

export async function saveEightDDraft(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  leaderId: string;
  teamMemberIds: string[];
  problemStatement: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const context = await requireEvent(tx, input);
    const previous = context.eightD;
    if (previous && previous.status !== "DRAFT") {
      throw new EightDError("EIGHT_D_LOCKED", "Approved 8D must be reopened before editing D1 or D2");
    }

    const teamMemberIds = uniqueTeam(input.leaderId, input.teamMemberIds);
    for (const userId of teamMemberIds) {
      await validateTeamMember(tx, { ...input, userId });
    }
    const problemStatement = input.problemStatement.trim();
    if (!problemStatement) {
      throw new EightDError("PROBLEM_STATEMENT_REQUIRED", "D2 requires a clear problem statement");
    }

    const now = new Date().toISOString();
    const snapshot: EightDSnapshot = {
      eventId: input.eventId,
      organizationId: input.organizationId,
      siteId: input.siteId,
      status: "DRAFT",
      leaderId: input.leaderId,
      teamMemberIds,
      problemStatement,
      preventionSummary: previous?.preventionSummary ?? null,
      recognitionNote: previous?.recognitionNote ?? null,
      approvedById: null,
      approvedAt: null,
      closedById: null,
      closedAt: null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: previous ? "D1_D2_UPDATED" : "CREATED",
      previous,
    });
    return snapshot;
  });
}

export async function approveEightD(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const context = await requireEvent(tx, input);
    const previous = context.eightD;
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new EightDError("EIGHT_D_NOT_FOUND", "8D draft not found in site scope");
    }
    if (previous.status === "CLOSED") return previous;
    if (previous.status !== "DRAFT") {
      throw new EightDError("EIGHT_D_LOCKED", "Only draft 8D can be approved");
    }
    if (previous.teamMemberIds.length < 2 || !previous.teamMemberIds.includes(previous.leaderId)) {
      throw new EightDError("TEAM_REQUIRED", "D1 requires a leader and at least one additional team member");
    }
    for (const userId of previous.teamMemberIds) {
      await validateTeamMember(tx, { ...input, userId });
    }
    if (!previous.problemStatement.trim()) {
      throw new EightDError("PROBLEM_STATEMENT_REQUIRED", "D2 requires a clear problem statement");
    }
    if (!context.event?.containment?.completedAt) {
      throw new EightDError(
        "CONTAINMENT_REQUIRED",
        "Complete immediate containment before approving the 8D team and problem definition",
      );
    }

    const now = new Date().toISOString();
    const snapshot: EightDSnapshot = {
      ...previous,
      status: "ACTIVE",
      approvedById: input.actorId,
      approvedAt: now,
      updatedAt: now,
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "APPROVED", previous });
    return snapshot;
  });
}

export async function recordEightDPrevention(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  preventionSummary: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const context = await requireEvent(tx, input);
    const previous = context.eightD;
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new EightDError("EIGHT_D_NOT_FOUND", "8D not found in site scope");
    }
    if (previous.status !== "ACTIVE") {
      throw new EightDError("EIGHT_D_LOCKED", "D7 can only be recorded on an active 8D");
    }
    if (context.rootCause?.status !== "CONFIRMED") {
      throw new EightDError("ROOT_CAUSE_REQUIRED", "Confirm D4 root cause before recording D7 prevention");
    }
    if (context.capa?.status !== "CLOSED") {
      throw new EightDError("CAPA_REQUIRED", "Close effective CAPA before recording D7 prevention");
    }
    const preventionSummary = input.preventionSummary.trim();
    if (!preventionSummary) {
      throw new EightDError("PREVENTION_REQUIRED", "D7 requires a prevention-of-recurrence summary");
    }
    const snapshot: EightDSnapshot = {
      ...previous,
      preventionSummary,
      updatedAt: new Date().toISOString(),
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "D7_RECORDED", previous });
    return snapshot;
  });
}

export async function closeEightD(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  recognitionNote: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const context = await requireEvent(tx, input);
    const previous = context.eightD;
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new EightDError("EIGHT_D_NOT_FOUND", "8D not found in site scope");
    }
    if (previous.status === "CLOSED") return previous;
    if (previous.status !== "ACTIVE") {
      throw new EightDError("EIGHT_D_LOCKED", "Only active 8D can be closed");
    }
    if (context.rootCause?.status !== "CONFIRMED") {
      throw new EightDError("ROOT_CAUSE_REQUIRED", "D4 root cause must be confirmed before 8D closure");
    }
    if (context.capa?.status !== "CLOSED") {
      throw new EightDError("CAPA_REQUIRED", "D5/D6 CAPA must be effective and closed before 8D closure");
    }
    if (!previous.preventionSummary?.trim()) {
      throw new EightDError("PREVENTION_REQUIRED", "D7 must be recorded before 8D closure");
    }
    const recognitionNote = input.recognitionNote.trim();
    if (!recognitionNote) {
      throw new EightDError("RECOGNITION_REQUIRED", "D8 requires a recognition and closure note");
    }
    const now = new Date().toISOString();
    const snapshot: EightDSnapshot = {
      ...previous,
      status: "CLOSED",
      recognitionNote,
      closedById: input.actorId,
      closedAt: now,
      updatedAt: now,
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "CLOSED", previous });
    return snapshot;
  });
}

export async function reopenEightD(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    const context = await requireEvent(tx, input);
    const previous = context.eightD;
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new EightDError("EIGHT_D_NOT_FOUND", "8D not found in site scope");
    }
    if (previous.status !== "CLOSED") {
      throw new EightDError("EIGHT_D_ALREADY_CLOSED", "Only closed 8D can be reopened");
    }
    const snapshot: EightDSnapshot = {
      ...previous,
      status: "DRAFT",
      approvedById: null,
      approvedAt: null,
      recognitionNote: null,
      closedById: null,
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "REOPENED", previous });
    return snapshot;
  });
}

function disciplines(
  event: QualityEventReference,
  rootCause: RootCauseReference | null,
  capa: CapaReference | null,
  eightD: EightDSnapshot | null,
) {
  const teamComplete = Boolean(
    eightD && eightD.teamMemberIds.length >= 2 && eightD.teamMemberIds.includes(eightD.leaderId),
  );
  const problemComplete = Boolean(eightD?.problemStatement.trim());
  const containmentComplete = Boolean(event.containment?.completedAt);
  const rootCauseComplete = rootCause?.status === "CONFIRMED";
  const correctiveActionsComplete = Boolean(capa && capa.status !== "DRAFT" && capa.actions.length > 0);
  const implementationComplete = capa?.status === "CLOSED";
  const preventionComplete = Boolean(eightD?.preventionSummary?.trim());
  const closureComplete = eightD?.status === "CLOSED";

  const values: Array<{ key: EightDDisciplineKey; label: string; complete: boolean; source: string }> = [
    { key: "D1", label: "Build the team", complete: teamComplete, source: "8D" },
    { key: "D2", label: "Describe the problem", complete: problemComplete, source: "8D" },
    { key: "D3", label: "Contain the problem", complete: containmentComplete, source: "Quality event" },
    { key: "D4", label: "Identify root cause", complete: rootCauseComplete, source: "Root cause" },
    { key: "D5", label: "Choose permanent corrective actions", complete: correctiveActionsComplete, source: "CAPA" },
    { key: "D6", label: "Implement and validate actions", complete: implementationComplete, source: "CAPA" },
    { key: "D7", label: "Prevent recurrence", complete: preventionComplete, source: "8D" },
    { key: "D8", label: "Recognize team and close", complete: closureComplete, source: "8D" },
  ];
  return values;
}

export async function getEightDWorkspace(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const context = await currentContext(
    db as unknown as Pick<Prisma.TransactionClient, "auditLog">,
    input.eventId,
  );
  if (
    !context.event ||
    context.event.organizationId !== input.organizationId ||
    context.event.siteId !== input.siteId
  ) {
    return null;
  }
  if (
    context.eightD &&
    (context.eightD.organizationId !== input.organizationId || context.eightD.siteId !== input.siteId)
  ) {
    return null;
  }
  return {
    ...context,
    disciplines: disciplines(context.event, context.rootCause, context.capa, context.eightD),
  };
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
