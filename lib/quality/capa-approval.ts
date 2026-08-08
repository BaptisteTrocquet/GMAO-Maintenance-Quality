import { db } from "@/lib/db";

const CAPA_ENTITY_TYPE = "QualityCapa";
const DRAFT_EDIT_ACTIONS = new Set(["CREATED", "PLAN_UPDATED"]);
const DRAFT_CYCLE_BOUNDARIES = new Set([
  "APPROVED",
  "EFFECTIVENESS_FAILED",
  "REOPENED",
]);

export class CapaApprovalGuardError extends Error {
  constructor(
    public readonly code: "CAPA_APPROVER_NOT_ALLOWED" | "CAPA_SELF_APPROVAL_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "CapaApprovalGuardError";
  }
}

export async function assertIndependentCapaApprover(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  approverId: string;
}) {
  const membership = await db.organizationMembership.findFirst({
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
    select: { id: true },
  });
  if (!membership) {
    throw new CapaApprovalGuardError(
      "CAPA_APPROVER_NOT_ALLOWED",
      "CAPA approval requires an active owner, admin or quality manager with access to this site",
    );
  }

  const timeline = await db.auditLog.findMany({
    where: {
      entityType: CAPA_ENTITY_TYPE,
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
  for (const entry of timeline) {
    if (DRAFT_CYCLE_BOUNDARIES.has(entry.action)) {
      currentDraftAuthors.clear();
      continue;
    }
    if (DRAFT_EDIT_ACTIONS.has(entry.action) && entry.actorId) {
      currentDraftAuthors.add(entry.actorId);
    }
  }

  if (currentDraftAuthors.has(input.approverId)) {
    throw new CapaApprovalGuardError(
      "CAPA_SELF_APPROVAL_NOT_ALLOWED",
      "A user who authored or edited the current CAPA draft cannot approve it",
    );
  }
}
