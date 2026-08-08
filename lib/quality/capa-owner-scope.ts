import { db } from "@/lib/db";

export class CapaOwnerScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapaOwnerScopeError";
  }
}

export async function assertCapaOwnersInSite(input: {
  organizationId: string;
  siteId: string;
  ownerIds: string[];
}) {
  const ownerIds = [...new Set(input.ownerIds.filter(Boolean))];
  if (!ownerIds.length) return;

  const memberships = await db.organizationMembership.findMany({
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
  const allowed = new Set(memberships.map((membership) => membership.userId));
  const missing = ownerIds.filter((ownerId) => !allowed.has(ownerId));
  if (missing.length) {
    throw new CapaOwnerScopeError("Every CAPA owner must be an active member of the selected site");
  }
}
