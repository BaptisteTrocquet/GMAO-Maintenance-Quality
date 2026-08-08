import { db } from "@/lib/db";

const CAPA_ENTITY_TYPE = "QualityCapa";
const APPROVER_ROLES = new Set(["OWNER", "ADMIN", "QUALITY_MANAGER"] as const);

export class CapaApprovalPolicyError extends Error {
  constructor(
    public readonly code:
      | "CAPA_NOT_FOUND"
      | "CAPA_APPROVER_NOT_AUTHORIZED"
      | "CAPA_SELF_APPROVAL_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "CapaApprovalPolicyError";
  }
}

export async function assertCapaApprovalPolicy(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
  actorId: string;
}) {
  const [membership, created] = await Promise.all([
    db.organizationMembership.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.actorId,
        active: true,
        user: { active: true },
        OR: [
          { allSites: true },
          { siteMemberships: { some: { siteId: input.siteId } } },
        ],
      },
      select: { role: true },
    }),
    db.auditLog.findFirst({
      where: {
        entityType: CAPA_ENTITY_TYPE,
        entityId: input.eventId,
        action: "CREATED",
      },
      orderBy: { createdAt: "asc" },
      select: { actorId: true, afterJson: true },
    }),
  ]);

  if (!created) {
    throw new CapaApprovalPolicyError("CAPA_NOT_FOUND", "CAPA draft not found");
  }

  let scopeMatches = false;
  try {
    const snapshot = created.afterJson
      ? (JSON.parse(created.afterJson) as { organizationId?: unknown; siteId?: unknown })
      : null;
    scopeMatches =
      snapshot?.organizationId === input.organizationId && snapshot.siteId === input.siteId;
  } catch {
    scopeMatches = false;
  }
  if (!scopeMatches) {
    throw new CapaApprovalPolicyError("CAPA_NOT_FOUND", "CAPA draft not found in site scope");
  }

  if (!membership || !APPROVER_ROLES.has(membership.role as "OWNER" | "ADMIN" | "QUALITY_MANAGER")) {
    throw new CapaApprovalPolicyError(
      "CAPA_APPROVER_NOT_AUTHORIZED",
      "CAPA approval requires an active Owner, Admin or Quality Manager with access to this site",
    );
  }

  if (created.actorId === input.actorId) {
    throw new CapaApprovalPolicyError(
      "CAPA_SELF_APPROVAL_NOT_ALLOWED",
      "The CAPA draft author cannot approve their own CAPA",
    );
  }
}
