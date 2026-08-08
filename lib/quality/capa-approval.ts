import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { latestCapaSnapshot, type CapaSnapshot } from "@/lib/quality/capa";

const CAPA_ENTITY = "QualityCapa";
const APPROVAL_ENTITY = "QualityCapaApproval";
const QUALITY_EVENT_ENTITY = "QualityEvent";
const ROOT_CAUSE_ENTITY = "QualityRootCause";
const ALLOWED_APPROVER_ROLES = ["OWNER", "ADMIN", "QUALITY_MANAGER"] as const;
const MAX_TRANSACTION_ATTEMPTS = 4;

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

export class CapaApprovalError extends Error {
  constructor(
    public readonly code:
      | "QUALITY_EVENT_NOT_FOUND"
      | "ROOT_CAUSE_REQUIRED"
      | "CAPA_NOT_FOUND"
      | "CAPA_NOT_DRAFT"
      | "CAPA_APPROVER_NOT_ALLOWED"
      | "CAPA_SELF_APPROVAL_NOT_ALLOWED"
      | "ACTION_OWNER_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "CapaApprovalError";
  }
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
    ) {
      return null;
    }
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
    ) {
      return null;
    }
    return parsed as RootCauseState;
  } catch {
    return null;
  }
}

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
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

function requireScopedDraft(
  capa: CapaSnapshot | null,
  input: { organizationId: string; siteId: string },
) {
  if (!capa || capa.organizationId !== input.organizationId || capa.siteId !== input.siteId) {
    throw new CapaApprovalError("CAPA_NOT_FOUND", "CAPA plan not found in site scope");
  }
  if (capa.status !== "DRAFT") {
    throw new CapaApprovalError("CAPA_NOT_DRAFT", "Only a draft CAPA can be approved");
  }
  if (!capa.planSummary.trim() || capa.actions.length === 0) {
    throw new CapaApprovalError(
      "CAPA_NOT_DRAFT",
      "CAPA approval requires a plan summary and at least one action",
    );
  }
  return capa;
}

export async function approveCapaWithSeparation(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  approverId: string;
  approvalNote?: string | null;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const [event, rootCause, capa, approver, draftEdits] = await Promise.all([
            latestJson(tx, QUALITY_EVENT_ENTITY, input.eventId).then(parseEvent),
            latestJson(tx, ROOT_CAUSE_ENTITY, input.eventId).then(parseRootCause),
            latestCapaSnapshot(tx, input.eventId),
            tx.organizationMembership.findFirst({
              where: {
                organizationId: input.organizationId,
                userId: input.approverId,
                active: true,
                role: { in: [...ALLOWED_APPROVER_ROLES] },
                user: { active: true },
                OR: [
                  { allSites: true },
                  { siteMemberships: { some: { siteId: input.siteId } } },
                ],
              },
              select: { id: true, role: true },
            }),
            tx.auditLog.findMany({
              where: {
                entityType: CAPA_ENTITY,
                entityId: input.eventId,
                action: { in: ["CREATED", "PLAN_UPDATED"] },
              },
              select: { actorId: true },
            }),
          ]);

          if (!event || event.organizationId !== input.organizationId || event.siteId !== input.siteId) {
            throw new CapaApprovalError(
              "QUALITY_EVENT_NOT_FOUND",
              "Quality event not found in site scope",
            );
          }
          if (event.status !== "INVESTIGATING") {
            throw new CapaApprovalError(
              "CAPA_NOT_DRAFT",
              "CAPA can only be approved while the quality event is investigating",
            );
          }
          if (
            !rootCause ||
            rootCause.organizationId !== input.organizationId ||
            rootCause.siteId !== input.siteId ||
            rootCause.status !== "CONFIRMED"
          ) {
            throw new CapaApprovalError(
              "ROOT_CAUSE_REQUIRED",
              "Confirm root-cause analysis before CAPA approval",
            );
          }

          const draft = requireScopedDraft(capa, input);
          if (!approver) {
            throw new CapaApprovalError(
              "CAPA_APPROVER_NOT_ALLOWED",
              "CAPA approval requires an active Owner, Admin or Quality Manager with site access",
            );
          }
          if (draftEdits.some((edit) => edit.actorId === input.approverId)) {
            throw new CapaApprovalError(
              "CAPA_SELF_APPROVAL_NOT_ALLOWED",
              "A user who authored or edited the CAPA draft cannot approve that draft",
            );
          }

          const ownerIds = [...new Set(draft.actions.map((action) => action.ownerId))];
          const owners = await tx.organizationMembership.findMany({
            where: {
              organizationId: input.organizationId,
              userId: { in: ownerIds },
              active: true,
              user: { active: true },
              OR: [
                { allSites: true },
                { siteMemberships: { some: { siteId: input.siteId } } },
              ],
            },
            select: { userId: true },
          });
          const validOwnerIds = new Set(owners.map((owner) => owner.userId));
          if (ownerIds.some((ownerId) => !validOwnerIds.has(ownerId))) {
            throw new CapaApprovalError(
              "ACTION_OWNER_NOT_FOUND",
              "Every CAPA action owner must still be active and have access to this site",
            );
          }

          const now = new Date().toISOString();
          const approved: CapaSnapshot = {
            ...draft,
            status: "ACTIVE",
            approvedById: input.approverId,
            approvedAt: now,
            updatedAt: now,
            closedAt: null,
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
                approvedDraftUpdatedAt: draft.updatedAt,
                approvalNote: input.approvalNote?.trim() || null,
              }),
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: input.approverId,
              entityType: CAPA_ENTITY,
              entityId: input.eventId,
              action: "APPROVED",
              beforeJson: JSON.stringify(draft),
              afterJson: JSON.stringify(approved),
            },
          });

          return approved;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}
