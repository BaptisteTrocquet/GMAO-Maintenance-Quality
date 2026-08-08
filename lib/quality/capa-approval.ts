import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { type CapaSnapshot } from "@/lib/quality/capa";

const CAPA_ENTITY = "QualityCapa";
const APPROVAL_ENTITY = "QualityCapaApproval";
const QUALITY_EVENT_ENTITY = "QualityEvent";
const ROOT_CAUSE_ENTITY = "QualityRootCause";
const MAX_TRANSACTION_ATTEMPTS = 4;

type EventState = {
  organizationId: string;
  siteId: string;
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
};

type RootCauseState = {
  organizationId: string;
  siteId: string;
  status: "DRAFT" | "CONFIRMED";
};

export class CapaApprovalError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "EVENT_NOT_INVESTIGATING"
      | "ROOT_CAUSE_CONFIRMATION_REQUIRED"
      | "CAPA_NOT_FOUND"
      | "CAPA_NOT_DRAFT"
      | "CAPA_APPROVER_NOT_ALLOWED"
      | "CAPA_SELF_APPROVAL_NOT_ALLOWED"
      | "ACTION_OWNER_NOT_FOUND"
      | "ACTION_DATA_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "CapaApprovalError";
  }
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseCapa(value: string | null): CapaSnapshot | null {
  const parsed = parseJson<Partial<CapaSnapshot>>(value);
  if (
    !parsed ||
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
  ) {
    return null;
  }
  return parsed as CapaSnapshot;
}

async function latestJson(
  tx: Prisma.TransactionClient,
  entityType: string,
  entityId: string,
) {
  const record = await tx.auditLog.findFirst({
    where: { entityType, entityId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return record?.afterJson ?? null;
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

export async function approveCapa(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  approverId: string;
  approvalNote?: string | null;
}) {
  return serializable(async (tx) => {
    const event = parseJson<EventState>(await latestJson(tx, QUALITY_EVENT_ENTITY, input.eventId));
    if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
      throw new CapaApprovalError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope");
    }
    if (event.status !== "INVESTIGATING") {
      throw new CapaApprovalError(
        "EVENT_NOT_INVESTIGATING",
        "CAPA can only be approved while the quality event is investigating",
      );
    }

    const rootCause = parseJson<RootCauseState>(await latestJson(tx, ROOT_CAUSE_ENTITY, input.eventId));
    if (
      !rootCause ||
      rootCause.organizationId !== input.organizationId ||
      rootCause.siteId !== input.siteId ||
      rootCause.status !== "CONFIRMED"
    ) {
      throw new CapaApprovalError(
        "ROOT_CAUSE_CONFIRMATION_REQUIRED",
        "Confirm root-cause analysis before approving CAPA",
      );
    }

    const capa = parseCapa(await latestJson(tx, CAPA_ENTITY, input.eventId));
    if (!capa || capa.organizationId !== input.organizationId || capa.siteId !== input.siteId) {
      throw new CapaApprovalError("CAPA_NOT_FOUND", "CAPA plan not found in site scope");
    }
    if (capa.status !== "DRAFT") {
      throw new CapaApprovalError("CAPA_NOT_DRAFT", "Only draft CAPA plans can be approved");
    }
    if (!capa.objective.trim() || capa.actions.length === 0) {
      throw new CapaApprovalError(
        "ACTION_DATA_REQUIRED",
        "CAPA approval requires an objective and at least one action",
      );
    }

    const approverMembership = await tx.organizationMembership.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.approverId,
        active: true,
        role: { in: ["OWNER", "ADMIN", "QUALITY_MANAGER"] },
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId: input.siteId } } }],
      },
      select: { id: true, role: true },
    });
    if (!approverMembership) {
      throw new CapaApprovalError(
        "CAPA_APPROVER_NOT_ALLOWED",
        "CAPA approval requires an active quality manager, admin or owner with access to this site",
      );
    }

    const createdEvent = await tx.auditLog.findFirst({
      where: { entityType: CAPA_ENTITY, entityId: input.eventId, action: "CAPA_DRAFT_CREATED" },
      orderBy: { createdAt: "asc" },
      select: { actorId: true },
    });
    if (createdEvent?.actorId && createdEvent.actorId === input.approverId) {
      throw new CapaApprovalError(
        "CAPA_SELF_APPROVAL_NOT_ALLOWED",
        "The CAPA draft author cannot approve their own CAPA plan",
      );
    }

    const ownerIds = [...new Set(capa.actions.map((action) => action.ownerId))];
    const owners = await tx.organizationMembership.findMany({
      where: {
        organizationId: input.organizationId,
        userId: { in: ownerIds },
        active: true,
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId: input.siteId } } }],
      },
      select: { userId: true },
    });
    const validOwners = new Set(owners.map((owner) => owner.userId));
    if (ownerIds.some((ownerId) => !validOwners.has(ownerId))) {
      throw new CapaApprovalError(
        "ACTION_OWNER_NOT_FOUND",
        "Each CAPA action owner must still have active access to this site at approval time",
      );
    }

    const now = new Date().toISOString();
    const approved: CapaSnapshot = {
      ...capa,
      status: "ACTIVE",
      updatedAt: now,
      activatedAt: now,
    };

    await tx.auditLog.create({
      data: {
        actorId: input.approverId,
        entityType: APPROVAL_ENTITY,
        entityId: input.eventId,
        action: "CAPA_APPROVED",
        afterJson: JSON.stringify({
          organizationId: input.organizationId,
          siteId: input.siteId,
          eventId: input.eventId,
          approverId: input.approverId,
          approverRole: approverMembership.role,
          approvalNote: input.approvalNote?.trim() || null,
          approvedAt: now,
          approvedDraftUpdatedAt: capa.updatedAt,
        }),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.approverId,
        entityType: CAPA_ENTITY,
        entityId: input.eventId,
        action: "CAPA_ACTIVATED",
        beforeJson: JSON.stringify(capa),
        afterJson: JSON.stringify(approved),
      },
    });

    return approved;
  });
}
