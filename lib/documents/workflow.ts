import type { ApprovalDecision, MembershipRole } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export type DocumentWorkflowErrorCode =
  | "DOCUMENT_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "REVISION_FILE_REQUIRED"
  | "INVALID_REVISION_STATUS"
  | "APPROVER_REQUIRED"
  | "APPROVER_NOT_ELIGIBLE"
  | "APPROVER_NOT_ASSIGNED"
  | "APPROVAL_ALREADY_DECIDED"
  | "APPROVALS_PENDING"
  | "EFFECTIVE_DATE_REQUIRED";

export class DocumentWorkflowError extends Error {
  constructor(
    public readonly code: DocumentWorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentWorkflowError";
  }
}

async function findRevision(input: {
  organizationId: string;
  documentId: string;
  revisionId: string;
}) {
  const revision = await db.documentRevision.findFirst({
    where: {
      id: input.revisionId,
      documentId: input.documentId,
      document: { organizationId: input.organizationId },
    },
    include: {
      document: { select: { id: true, code: true, title: true } },
      approvals: true,
    },
  });
  if (!revision) {
    throw new DocumentWorkflowError("REVISION_NOT_FOUND", "Document revision not found");
  }
  return revision;
}

async function audit(input: {
  actorId?: string | null;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
}) {
  await db.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      entityType: "DocumentRevision",
      entityId: input.entityId,
      action: input.action,
      beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
      afterJson: input.after === undefined ? null : JSON.stringify(input.after),
    },
  });
}

export async function submitRevisionForReview(input: {
  organizationId: string;
  documentId: string;
  revisionId: string;
  actorId: string;
}) {
  const revision = await findRevision(input);
  if (revision.status !== "DRAFT") {
    throw new DocumentWorkflowError(
      "INVALID_REVISION_STATUS",
      "Only DRAFT revisions can be submitted for review",
    );
  }
  if (!revision.storageKey || !revision.checksum) {
    throw new DocumentWorkflowError(
      "REVISION_FILE_REQUIRED",
      "A controlled file must be attached before review",
    );
  }

  const updated = await db.documentRevision.update({
    where: { id: revision.id },
    data: { status: "IN_REVIEW" },
    include: { approvals: true },
  });
  await audit({
    actorId: input.actorId,
    entityId: revision.id,
    action: "SUBMITTED_FOR_REVIEW",
    before: revision,
    after: updated,
  });
  return updated;
}

function uniqueIds(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export async function requestRevisionApproval(input: {
  organizationId: string;
  documentId: string;
  revisionId: string;
  approverIds: string[];
  actorId: string;
}) {
  const revision = await findRevision(input);
  if (revision.status !== "IN_REVIEW") {
    throw new DocumentWorkflowError(
      "INVALID_REVISION_STATUS",
      "Approval can only be requested while a revision is IN_REVIEW",
    );
  }

  const approverIds = uniqueIds(input.approverIds);
  if (approverIds.length === 0) {
    throw new DocumentWorkflowError("APPROVER_REQUIRED", "At least one approver is required");
  }

  const memberships = await db.organizationMembership.findMany({
    where: {
      organizationId: input.organizationId,
      userId: { in: approverIds },
      active: true,
      user: { active: true },
    },
    select: { userId: true, role: true },
  });
  const eligible = new Set(
    memberships
      .filter((membership: { role: MembershipRole }) => can(membership.role, "document:approve"))
      .map((membership: { userId: string }) => membership.userId),
  );
  const ineligible = approverIds.filter((approverId) => !eligible.has(approverId));
  if (ineligible.length > 0) {
    throw new DocumentWorkflowError(
      "APPROVER_NOT_ELIGIBLE",
      "Every approver must be an active organization member with document approval permission",
    );
  }

  await db.$transaction(async (tx) => {
    await tx.documentApproval.deleteMany({ where: { documentRevisionId: revision.id } });
    await tx.documentApproval.createMany({
      data: approverIds.map((approverId) => ({
        documentRevisionId: revision.id,
        approverId,
        decision: "PENDING" as ApprovalDecision,
      })),
    });
  });

  const updated = await findRevision(input);
  await audit({
    actorId: input.actorId,
    entityId: revision.id,
    action: "APPROVAL_REQUESTED",
    before: { approvals: revision.approvals },
    after: { approverIds },
  });
  return updated;
}

export async function decideRevisionApproval(input: {
  organizationId: string;
  documentId: string;
  revisionId: string;
  actorId: string;
  decision: "APPROVED" | "REJECTED";
  comment?: string | null;
}) {
  const revision = await findRevision(input);
  if (revision.status !== "IN_REVIEW") {
    throw new DocumentWorkflowError(
      "INVALID_REVISION_STATUS",
      "Approval decisions can only be recorded while a revision is IN_REVIEW",
    );
  }

  const assigned = revision.approvals.find((approval) => approval.approverId === input.actorId);
  if (!assigned) {
    throw new DocumentWorkflowError(
      "APPROVER_NOT_ASSIGNED",
      "The current user is not assigned to approve this revision",
    );
  }
  if (assigned.decision !== "PENDING") {
    throw new DocumentWorkflowError(
      "APPROVAL_ALREADY_DECIDED",
      "This approver has already decided this revision",
    );
  }

  const decidedAt = new Date();
  const approval = await db.documentApproval.update({
    where: { id: assigned.id },
    data: {
      decision: input.decision,
      comment: input.comment ?? null,
      decidedAt,
    },
  });
  await audit({
    actorId: input.actorId,
    entityId: revision.id,
    action: input.decision === "APPROVED" ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED",
    before: assigned,
    after: approval,
  });

  if (input.decision === "REJECTED") {
    const returned = await db.documentRevision.update({
      where: { id: revision.id },
      data: { status: "DRAFT", effectiveAt: null },
      include: { approvals: true },
    });
    await audit({
      actorId: input.actorId,
      entityId: revision.id,
      action: "RETURNED_TO_DRAFT",
      before: { status: revision.status },
      after: { status: returned.status },
    });
    return returned;
  }

  const remaining = await db.documentApproval.count({
    where: { documentRevisionId: revision.id, decision: { not: "APPROVED" } },
  });
  if (remaining > 0) return findRevision(input);

  const approved = await db.documentRevision.update({
    where: { id: revision.id },
    data: { status: "APPROVED" },
    include: { approvals: true },
  });
  await audit({
    actorId: input.actorId,
    entityId: revision.id,
    action: "REVISION_APPROVED",
    before: { status: revision.status },
    after: { status: approved.status },
  });
  return approved;
}

export async function scheduleRevisionEffective(input: {
  organizationId: string;
  documentId: string;
  revisionId: string;
  effectiveAt: Date;
  actorId: string;
  now?: Date;
}) {
  const revision = await findRevision(input);
  if (revision.status !== "APPROVED" && revision.status !== "EFFECTIVE") {
    throw new DocumentWorkflowError(
      "INVALID_REVISION_STATUS",
      "Only APPROVED revisions can be scheduled to become effective",
    );
  }
  if (!input.effectiveAt || Number.isNaN(input.effectiveAt.getTime())) {
    throw new DocumentWorkflowError("EFFECTIVE_DATE_REQUIRED", "A valid effective date is required");
  }

  const scheduled = await db.documentRevision.update({
    where: { id: revision.id },
    data: { effectiveAt: input.effectiveAt },
    include: { approvals: true },
  });
  await audit({
    actorId: input.actorId,
    entityId: revision.id,
    action: "EFFECTIVE_DATE_SCHEDULED",
    before: { effectiveAt: revision.effectiveAt },
    after: { effectiveAt: scheduled.effectiveAt },
  });

  const now = input.now ?? new Date();
  if (input.effectiveAt <= now) {
    return activateRevision({
      organizationId: input.organizationId,
      documentId: input.documentId,
      revisionId: input.revisionId,
      actorId: input.actorId,
      asOf: now,
    });
  }
  return scheduled;
}

export async function activateRevision(input: {
  organizationId: string;
  documentId: string;
  revisionId: string;
  actorId?: string | null;
  asOf?: Date;
}) {
  const revision = await findRevision(input);
  const asOf = input.asOf ?? new Date();
  if (!revision.effectiveAt || revision.effectiveAt > asOf) {
    throw new DocumentWorkflowError(
      "INVALID_REVISION_STATUS",
      "Revision effective date has not been reached",
    );
  }
  if (revision.status !== "APPROVED" && revision.status !== "EFFECTIVE") {
    throw new DocumentWorkflowError(
      "INVALID_REVISION_STATUS",
      "Only an APPROVED revision can become effective",
    );
  }

  const priorEffective = await db.documentRevision.findMany({
    where: {
      documentId: revision.documentId,
      id: { not: revision.id },
      status: "EFFECTIVE",
    },
    select: { id: true, revision: true },
  });

  await db.$transaction(async (tx) => {
    if (priorEffective.length > 0) {
      await tx.documentRevision.updateMany({
        where: { id: { in: priorEffective.map((item) => item.id) } },
        data: { status: "OBSOLETE" },
      });
    }
    await tx.documentRevision.update({
      where: { id: revision.id },
      data: { status: "EFFECTIVE" },
    });
  });

  const effective = await findRevision(input);
  await audit({
    actorId: input.actorId ?? null,
    entityId: revision.id,
    action: "REVISION_EFFECTIVE",
    before: { status: revision.status, superseded: priorEffective },
    after: { status: effective.status, effectiveAt: effective.effectiveAt },
  });
  for (const prior of priorEffective) {
    await audit({
      actorId: input.actorId ?? null,
      entityId: prior.id,
      action: "REVISION_SUPERSEDED",
      before: { status: "EFFECTIVE" },
      after: { status: "OBSOLETE", supersededById: revision.id },
    });
  }
  return effective;
}

export async function resolveEffectiveRevision(input: {
  organizationId: string;
  documentId: string;
  asOf?: Date;
}) {
  const document = await db.document.findFirst({
    where: { id: input.documentId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!document) {
    throw new DocumentWorkflowError("DOCUMENT_NOT_FOUND", "Document not found");
  }

  return db.documentRevision.findFirst({
    where: {
      documentId: document.id,
      status: { in: ["APPROVED", "EFFECTIVE"] },
      effectiveAt: { lte: input.asOf ?? new Date() },
    },
    include: { approvals: true },
    orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
  });
}

export async function reconcileEffectiveRevisions(input: {
  organizationId: string;
  asOf?: Date;
  actorId?: string | null;
}) {
  const asOf = input.asOf ?? new Date();
  const due = await db.documentRevision.findMany({
    where: {
      document: { organizationId: input.organizationId },
      status: "APPROVED",
      effectiveAt: { lte: asOf },
    },
    select: { id: true, documentId: true, effectiveAt: true },
    orderBy: [{ documentId: "asc" }, { effectiveAt: "desc" }, { createdAt: "desc" }],
  });

  const latestByDocument = new Map<string, (typeof due)[number]>();
  for (const revision of due) {
    if (!latestByDocument.has(revision.documentId)) latestByDocument.set(revision.documentId, revision);
  }

  const activated = [];
  for (const revision of latestByDocument.values()) {
    activated.push(
      await activateRevision({
        organizationId: input.organizationId,
        documentId: revision.documentId,
        revisionId: revision.id,
        actorId: input.actorId ?? null,
        asOf,
      }),
    );
  }
  return { asOf, activated };
}
