import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const ENTITY_TYPE = "QualityRootCauseAnalysis";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type RootCauseAnalysisStatus = "DRAFT" | "COMPLETED";

export type FiveWhyStep = {
  sequence: number;
  answer: string;
};

export type RootCauseAnalysisSnapshot = {
  id: string;
  version: number;
  organizationId: string;
  siteId: string;
  qualityEventId: string;
  status: RootCauseAnalysisStatus;
  problemStatement: string;
  fiveWhys: FiveWhyStep[];
  rootCauseConclusion: string | null;
  createdById: string;
  completedById: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class RootCauseAnalysisError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "INVESTIGATION_REQUIRED"
      | "ANALYSIS_NOT_FOUND"
      | "ANALYSIS_COMPLETED"
      | "ANALYSIS_NOT_COMPLETED"
      | "FIVE_WHYS_INCOMPLETE"
      | "ROOT_CAUSE_CONCLUSION_REQUIRED"
      | "CONCURRENT_UPDATE",
    message: string,
  ) {
    super(message);
    this.name = "RootCauseAnalysisError";
  }
}

function parseAnalysis(value: string | null): RootCauseAnalysisSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RootCauseAnalysisSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.version !== "number" ||
      !Number.isInteger(parsed.version) ||
      parsed.version < 1 ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.qualityEventId !== "string" ||
      (parsed.status !== "DRAFT" && parsed.status !== "COMPLETED") ||
      typeof parsed.problemStatement !== "string" ||
      !Array.isArray(parsed.fiveWhys) ||
      !(parsed.rootCauseConclusion === null || typeof parsed.rootCauseConclusion === "string") ||
      typeof parsed.createdById !== "string" ||
      !(parsed.completedById === null || typeof parsed.completedById === "string") ||
      !(parsed.completedAt === null || typeof parsed.completedAt === "string") ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as RootCauseAnalysisSnapshot;
  } catch {
    return null;
  }
}

async function latestAnalysis(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  eventId: string,
) {
  const events = await client.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, entityId: eventId },
    select: { afterJson: true },
  });

  let latest: RootCauseAnalysisSnapshot | null = null;
  for (const event of events) {
    const snapshot = parseAnalysis(event.afterJson);
    if (snapshot && (!latest || snapshot.version > latest.version)) latest = snapshot;
  }
  return latest;
}

function versionEventId(eventId: string, version: number) {
  return `quality-root-cause:${eventId}:v${version}`;
}

async function appendAnalysis(
  tx: Prisma.TransactionClient,
  snapshot: RootCauseAnalysisSnapshot,
  input: {
    actorId: string;
    action: "RCA_CREATED" | "RCA_UPDATED" | "RCA_COMPLETED" | "RCA_REOPENED";
    previous?: RootCauseAnalysisSnapshot | null;
  },
) {
  await tx.auditLog.create({
    data: {
      id: versionEventId(snapshot.qualityEventId, snapshot.version),
      actorId: input.actorId,
      entityType: ENTITY_TYPE,
      entityId: snapshot.qualityEventId,
      action: input.action,
      beforeJson: input.previous ? JSON.stringify(input.previous) : null,
      afterJson: JSON.stringify(snapshot),
    },
  });
}

function isRetryable(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || error.code === "P2002")
  );
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
      if (!isRetryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}

async function requireInvestigatingEvent(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const record = await tx.auditLog.findFirst({
    where: { entityType: "QualityEvent", entityId: input.eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });

  let event: { organizationId?: unknown; siteId?: unknown; status?: unknown } | null = null;
  try {
    event = record?.afterJson ? JSON.parse(record.afterJson) : null;
  } catch {
    event = null;
  }

  if (
    !event ||
    event.organizationId !== input.organizationId ||
    event.siteId !== input.siteId
  ) {
    throw new RootCauseAnalysisError(
      "QUALITY_EVENT_NOT_FOUND",
      "Quality event not found in site scope",
    );
  }
  if (event.status !== "INVESTIGATING") {
    throw new RootCauseAnalysisError(
      "INVESTIGATION_REQUIRED",
      "Root-cause analysis can only be edited while the quality event is investigating",
    );
  }
}

function normalizeFiveWhys(answers: string[]) {
  return answers.map((answer, index) => ({
    sequence: index + 1,
    answer: answer.trim(),
  }));
}

function requireFiveWhysComplete(analysis: RootCauseAnalysisSnapshot) {
  if (
    analysis.fiveWhys.length !== 5 ||
    analysis.fiveWhys.some(
      (step, index) => step.sequence !== index + 1 || !step.answer.trim(),
    )
  ) {
    throw new RootCauseAnalysisError(
      "FIVE_WHYS_INCOMPLETE",
      "All five Why answers are required before completing root-cause analysis",
    );
  }
  if (!analysis.rootCauseConclusion?.trim()) {
    throw new RootCauseAnalysisError(
      "ROOT_CAUSE_CONCLUSION_REQUIRED",
      "A root-cause conclusion is required before completing analysis",
    );
  }
}

export async function saveRootCauseAnalysis(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  problemStatement: string;
  fiveWhys: string[];
  rootCauseConclusion?: string | null;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestAnalysis(tx, input.eventId);
    if (previous?.status === "COMPLETED") {
      throw new RootCauseAnalysisError(
        "ANALYSIS_COMPLETED",
        "Completed root-cause analysis must be reopened before editing",
      );
    }

    const timestamp = new Date().toISOString();
    const snapshot: RootCauseAnalysisSnapshot = {
      id: input.eventId,
      version: (previous?.version ?? 0) + 1,
      organizationId: input.organizationId,
      siteId: input.siteId,
      qualityEventId: input.eventId,
      status: "DRAFT",
      problemStatement: input.problemStatement.trim(),
      fiveWhys: normalizeFiveWhys(input.fiveWhys),
      rootCauseConclusion: input.rootCauseConclusion?.trim() || null,
      createdById: previous?.createdById ?? input.actorId,
      completedById: null,
      completedAt: null,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    await appendAnalysis(tx, snapshot, {
      actorId: input.actorId,
      action: previous ? "RCA_UPDATED" : "RCA_CREATED",
      previous,
    });
    return snapshot;
  });
}

export async function transitionRootCauseAnalysis(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  action: "COMPLETE" | "REOPEN";
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestAnalysis(tx, input.eventId);
    if (!previous || previous.organizationId !== input.organizationId || previous.siteId !== input.siteId) {
      throw new RootCauseAnalysisError("ANALYSIS_NOT_FOUND", "Root-cause analysis not found");
    }

    const timestamp = new Date().toISOString();
    if (input.action === "COMPLETE") {
      if (previous.status === "COMPLETED") return previous;
      requireFiveWhysComplete(previous);
      const snapshot: RootCauseAnalysisSnapshot = {
        ...previous,
        version: previous.version + 1,
        status: "COMPLETED",
        completedById: input.actorId,
        completedAt: timestamp,
        updatedAt: timestamp,
      };
      await appendAnalysis(tx, snapshot, {
        actorId: input.actorId,
        action: "RCA_COMPLETED",
        previous,
      });
      return snapshot;
    }

    if (previous.status !== "COMPLETED") {
      throw new RootCauseAnalysisError(
        "ANALYSIS_NOT_COMPLETED",
        "Only completed root-cause analysis can be reopened",
      );
    }
    const snapshot: RootCauseAnalysisSnapshot = {
      ...previous,
      version: previous.version + 1,
      status: "DRAFT",
      completedById: null,
      completedAt: null,
      updatedAt: timestamp,
    };
    await appendAnalysis(tx, snapshot, {
      actorId: input.actorId,
      action: "RCA_REOPENED",
      previous,
    });
    return snapshot;
  });
}

export async function getRootCauseAnalysis(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const analysis = await latestAnalysis(
    db as unknown as Pick<Prisma.TransactionClient, "auditLog">,
    input.eventId,
  );
  if (
    !analysis ||
    analysis.organizationId !== input.organizationId ||
    analysis.siteId !== input.siteId
  ) {
    return null;
  }
  return analysis;
}

export async function listRootCauseTimeline(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const logs = await db.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, entityId: input.eventId },
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });

  return logs
    .map((log) => ({
      id: log.id,
      action: log.action,
      actorName: log.actor?.displayName ?? "System",
      createdAt: log.createdAt,
      after: parseAnalysis(log.afterJson),
    }))
    .filter(
      (entry) =>
        entry.after?.organizationId === input.organizationId &&
        entry.after.siteId === input.siteId,
    );
}
