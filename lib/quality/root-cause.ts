import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const ENTITY_TYPE = "QualityRootCause";
const QUALITY_EVENT_ENTITY_TYPE = "QualityEvent";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type RootCauseMethod = "FIVE_WHYS" | "ISHIKAWA" | "COMBINED";
export type RootCauseStatus = "DRAFT" | "CONFIRMED";
export type IshikawaCategory =
  | "PEOPLE"
  | "METHOD"
  | "MACHINE"
  | "MATERIAL"
  | "MEASUREMENT"
  | "ENVIRONMENT";

export type FiveWhyStep = {
  sequence: number;
  prompt: string;
  answer: string;
};

export type IshikawaCause = {
  category: IshikawaCategory;
  cause: string;
  evidence: string | null;
};

export type RootCauseSnapshot = {
  eventId: string;
  organizationId: string;
  siteId: string;
  status: RootCauseStatus;
  method: RootCauseMethod;
  problemStatement: string;
  fiveWhys: FiveWhyStep[];
  ishikawa: IshikawaCause[];
  rootCauseSummary: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
};

type QualityEventReference = {
  organizationId: string;
  siteId: string;
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
};

export class RootCauseError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "INVESTIGATION_REQUIRED"
      | "EVENT_CLOSED"
      | "ROOT_CAUSE_NOT_FOUND"
      | "ROOT_CAUSE_CONFIRMED"
      | "ROOT_CAUSE_ALREADY_DRAFT"
      | "INVALID_FIVE_WHYS"
      | "INVALID_ISHIKAWA"
      | "METHOD_DATA_REQUIRED"
      | "ROOT_CAUSE_SUMMARY_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "RootCauseError";
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

function parseSnapshot(value: string | null): RootCauseSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RootCauseSnapshot>;
    if (
      typeof parsed.eventId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      (parsed.status !== "DRAFT" && parsed.status !== "CONFIRMED") ||
      (parsed.method !== "FIVE_WHYS" &&
        parsed.method !== "ISHIKAWA" &&
        parsed.method !== "COMBINED") ||
      typeof parsed.problemStatement !== "string" ||
      !Array.isArray(parsed.fiveWhys) ||
      !Array.isArray(parsed.ishikawa) ||
      !(parsed.rootCauseSummary === null || typeof parsed.rootCauseSummary === "string") ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !(parsed.confirmedAt === null || typeof parsed.confirmedAt === "string")
    ) {
      return null;
    }
    return parsed as RootCauseSnapshot;
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

async function requireInvestigatingEvent(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; eventId: string },
) {
  const event = await currentQualityEvent(tx, input.eventId);
  if (
    !event ||
    event.organizationId !== input.organizationId ||
    event.siteId !== input.siteId
  ) {
    throw new RootCauseError(
      "QUALITY_EVENT_NOT_FOUND",
      "Quality event not found in site scope",
    );
  }
  if (event.status === "CLOSED") {
    throw new RootCauseError("EVENT_CLOSED", "Closed quality events cannot be investigated");
  }
  if (event.status !== "INVESTIGATING") {
    throw new RootCauseError(
      "INVESTIGATION_REQUIRED",
      "Start the quality-event investigation before editing root-cause analysis",
    );
  }
  return event;
}

async function latestSnapshot(
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

async function appendSnapshot(
  tx: Prisma.TransactionClient,
  snapshot: RootCauseSnapshot,
  input: {
    actorId: string;
    action: "CREATED" | "UPDATED" | "CONFIRMED" | "REOPENED";
    previous?: RootCauseSnapshot | null;
  },
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

function normalizeFiveWhys(steps: FiveWhyStep[]) {
  const sorted = [...steps].sort((left, right) => left.sequence - right.sequence);
  if (sorted.length > 5) {
    throw new RootCauseError("INVALID_FIVE_WHYS", "5 Why analysis supports at most five steps");
  }
  for (let index = 0; index < sorted.length; index += 1) {
    const step = sorted[index];
    if (
      step.sequence !== index + 1 ||
      !step.prompt.trim() ||
      !step.answer.trim()
    ) {
      throw new RootCauseError(
        "INVALID_FIVE_WHYS",
        "5 Why steps must be contiguous from 1 and include a prompt and answer",
      );
    }
  }
  return sorted.map((step) => ({
    sequence: step.sequence,
    prompt: step.prompt.trim(),
    answer: step.answer.trim(),
  }));
}

const ISHIKAWA_CATEGORIES = new Set<IshikawaCategory>([
  "PEOPLE",
  "METHOD",
  "MACHINE",
  "MATERIAL",
  "MEASUREMENT",
  "ENVIRONMENT",
]);

function normalizeIshikawa(causes: IshikawaCause[]) {
  if (causes.length > 100) {
    throw new RootCauseError("INVALID_ISHIKAWA", "Ishikawa analysis supports at most 100 causes");
  }
  return causes.map((cause) => {
    if (!ISHIKAWA_CATEGORIES.has(cause.category) || !cause.cause.trim()) {
      throw new RootCauseError(
        "INVALID_ISHIKAWA",
        "Each Ishikawa cause requires a supported category and non-empty cause",
      );
    }
    return {
      category: cause.category,
      cause: cause.cause.trim(),
      evidence: cause.evidence?.trim() || null,
    };
  });
}

function validateMethodData(
  method: RootCauseMethod,
  fiveWhys: FiveWhyStep[],
  ishikawa: IshikawaCause[],
) {
  if (method === "FIVE_WHYS" && fiveWhys.length === 0) {
    throw new RootCauseError("METHOD_DATA_REQUIRED", "5 Why analysis requires at least one step");
  }
  if (method === "ISHIKAWA" && ishikawa.length === 0) {
    throw new RootCauseError("METHOD_DATA_REQUIRED", "Ishikawa analysis requires at least one cause");
  }
  if (method === "COMBINED" && (fiveWhys.length === 0 || ishikawa.length === 0)) {
    throw new RootCauseError(
      "METHOD_DATA_REQUIRED",
      "Combined analysis requires both 5 Why steps and Ishikawa causes",
    );
  }
}

export async function saveRootCauseWorkspace(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  method: RootCauseMethod;
  problemStatement: string;
  fiveWhys?: FiveWhyStep[];
  ishikawa?: IshikawaCause[];
  rootCauseSummary?: string | null;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestSnapshot(tx, input.eventId);
    if (previous?.status === "CONFIRMED") {
      throw new RootCauseError(
        "ROOT_CAUSE_CONFIRMED",
        "Confirmed root-cause analysis must be reopened before editing",
      );
    }

    const fiveWhys = normalizeFiveWhys(input.fiveWhys ?? []);
    const ishikawa = normalizeIshikawa(input.ishikawa ?? []);
    validateMethodData(input.method, fiveWhys, ishikawa);

    const now = new Date().toISOString();
    const snapshot: RootCauseSnapshot = {
      eventId: input.eventId,
      organizationId: input.organizationId,
      siteId: input.siteId,
      status: "DRAFT",
      method: input.method,
      problemStatement: input.problemStatement.trim(),
      fiveWhys,
      ishikawa,
      rootCauseSummary: input.rootCauseSummary?.trim() || null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      confirmedAt: null,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: previous ? "UPDATED" : "CREATED",
      previous,
    });
    return snapshot;
  });
}

export async function confirmRootCauseWorkspace(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestSnapshot(tx, input.eventId);
    if (
      !previous ||
      previous.organizationId !== input.organizationId ||
      previous.siteId !== input.siteId
    ) {
      throw new RootCauseError("ROOT_CAUSE_NOT_FOUND", "Root-cause workspace not found");
    }
    if (previous.status === "CONFIRMED") return previous;

    validateMethodData(previous.method, previous.fiveWhys, previous.ishikawa);
    if (!previous.problemStatement.trim()) {
      throw new RootCauseError("METHOD_DATA_REQUIRED", "A problem statement is required");
    }
    if (!previous.rootCauseSummary?.trim()) {
      throw new RootCauseError(
        "ROOT_CAUSE_SUMMARY_REQUIRED",
        "A root-cause summary is required before confirmation",
      );
    }

    const now = new Date().toISOString();
    const snapshot: RootCauseSnapshot = {
      ...previous,
      status: "CONFIRMED",
      rootCauseSummary: previous.rootCauseSummary.trim(),
      updatedAt: now,
      confirmedAt: now,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: "CONFIRMED",
      previous,
    });
    return snapshot;
  });
}

export async function reopenRootCauseWorkspace(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  return serializable(async (tx) => {
    await requireInvestigatingEvent(tx, input);
    const previous = await latestSnapshot(tx, input.eventId);
    if (
      !previous ||
      previous.organizationId !== input.organizationId ||
      previous.siteId !== input.siteId
    ) {
      throw new RootCauseError("ROOT_CAUSE_NOT_FOUND", "Root-cause workspace not found");
    }
    if (previous.status !== "CONFIRMED") {
      throw new RootCauseError(
        "ROOT_CAUSE_ALREADY_DRAFT",
        "Only confirmed root-cause analysis can be reopened",
      );
    }

    const snapshot: RootCauseSnapshot = {
      ...previous,
      status: "DRAFT",
      updatedAt: new Date().toISOString(),
      confirmedAt: null,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: "REOPENED",
      previous,
    });
    return snapshot;
  });
}

export async function getRootCauseWorkspace(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const [event, rootCause] = await Promise.all([
    currentQualityEvent(
      db as unknown as Pick<Prisma.TransactionClient, "auditLog">,
      input.eventId,
    ),
    latestSnapshot(
      db as unknown as Pick<Prisma.TransactionClient, "auditLog">,
      input.eventId,
    ),
  ]);
  if (
    !event ||
    event.organizationId !== input.organizationId ||
    event.siteId !== input.siteId
  ) {
    return null;
  }
  if (
    rootCause &&
    (rootCause.organizationId !== input.organizationId || rootCause.siteId !== input.siteId)
  ) {
    return null;
  }
  return { event, rootCause };
}

export async function listRootCauseTimeline(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const workspace = await getRootCauseWorkspace(input);
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
