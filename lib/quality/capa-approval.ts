import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { latestCapaSnapshot, type CapaSnapshot } from "@/lib/quality/capa";

const QUALITY_EVENT_ENTITY = "QualityEvent";
const ROOT_CAUSE_ENTITY = "QualityRootCause";
const CAPA_ENTITY = "QualityCapa";
const APPROVAL_ENTITY = "QualityCapaApproval";
const MAX_TRANSACTION_ATTEMPTS = 4;
const DRAFT_EDIT_ACTIONS = new Set(["CREATED", "PLAN_UPDATED"]);
const DRAFT_CYCLE_BOUNDARIES = new Set([
  "APPROVED",
  "EFFECTIVENESS_FAILED",
  "REOPENED",
]);

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
      | "ROOT_CAUSE_REQUIRED"
      | "CAPA_NOT_FOUND"
      | "CAPA_NOT_DRAFT"
      | "CAPA_APPROVER_NOT_ALLOWED"
      | "CAPA_SELF_APPROVAL_NOT_ALLOWED"
      | "ACTION_OWNER_NOT_FOUND"
      | "ACTION_REQUIRED",
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

export async function approveCapaGoverned(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  approverId: string;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const event = parseJson<EventState>(
            await latestJson(tx, QUALITY_EVENT_ENTITY, input.eventId),
          );
          if (
            !event ||
            event.organizationId !== input.organizationId ||
            event.siteId !== input.siteId
          ) {
            throw new CapaApprovalError(
              "QUALITY_EVENT_NOT_FOUND",
              "Quality event not found in site scope",
            );
          }
          if (event.status !== "INVESTIGATING") {
            throw new CapaApprovalError(
              "EVENT_NOT_INVESTIGATING",
              "CAPA can only be approved while the quality event is investigating",
            );
          }

          const rootCause = parseJson<RootCauseState>(
            await latestJson(tx, ROOT_CAUSE_ENTITY, input.eventId),
          );
          if (
            !rootCause ||
            rootCause.organizationId !== input.organizationId ||
            rootCause.siteId !== input.siteId ||
            rootCause.status !== "CONFIRMED"
          ) {
            throw new CapaApprovalError(
              "ROOT_CAUSE_REQUIRED",
              "Confirm root-cause analysis before approving CAPA",
            );
          }

          const draft = await latestCapaSnapshot(tx, input.eventId);
          if (
            !draft ||
            draft.organizationId !== input.organizationId ||
            draft.siteId !== input.siteId
          ) {
            throw new CapaApprovalError("CAPA_NOT_FOUND", "CAPA plan not found in site scope");
          }
          if (draft.status !== "DRAFT") {
            throw new CapaApprovalError("CAPA_NOT_DRAFT", "Only draft CAPA can be approved");
          }
          if (!draft.planSummary.trim() || draft.actions.length === 0) {
            throw new CapaApprovalError(
              "ACTION_REQUIRED",
              "CAPA approval requires a plan summary and at least one action",
            );
          }

          const approver = await tx.organizationMembership.findFirst({
            where: {
              organizationId: input.organizationId,
              userId: input.approverId,
              active: true,
              role: { in: ["OWNER", "ADMIN", "QUALITY_MANAGER"] },
              user: { active: true },
              OR: [
                { allSites: true },
                { siteMemberships: { some: { siteId: input.siteId } } },
              ],
            },
            select: { role: true },
          });
          if (!approver) {
            throw new CapaApprovalError(
              "CAPA_APPROVER_NOT_ALLOWED",
              "CAPA approval requires an active quality manager, admin or owner with access to this site",
            );
          }

          const draftTimeline = await tx.auditLog.findMany({
            where: {
              entityType: CAPA_ENTITY,
              entityId: input.eventId,
              action: {
                in: [
                  ...DRAFT_EDIT_ACTIONS,
                  ...DRAFT_CYCLE_BOUNDARIES,
                ],
              },
            },
            orderBy: { createdAt: "asc" },
            select: { action: true, actorId: true },
          });
          const currentDraftAuthors = new Set<string>();
          for (const entry of draftTimeline) {
            if (DRAFT_CYCLE_BOUNDARIES.has(entry.action)) {
              currentDraftAuthors.clear();
              continue;
            }
            if (DRAFT_EDIT_ACTIONS.has(entry.action) && entry.actorId) {
              currentDraftAuthors.add(entry.actorId);
            }
          }
          if (currentDraftAuthors.has(input.approverId)) {
            throw new CapaApprovalError(
              "CAPA_SELF_APPROVAL_NOT_ALLOWED",
              "A user who authored or edited the current CAPA draft cannot approve that CAPA",
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
          const validOwners = new Set(owners.map((owner) => owner.userId));
          if (ownerIds.some((ownerId) => !validOwners.has(ownerId))) {
            throw new CapaApprovalError(
              "ACTION_OWNER_NOT_FOUND",
              "Each CAPA action owner must still have active access to this site at approval time",
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
                approverId: input.approverId,
                approverRole: approver.role,
                approvedDraftUpdatedAt: draft.updatedAt,
                approvedAt: now,
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
