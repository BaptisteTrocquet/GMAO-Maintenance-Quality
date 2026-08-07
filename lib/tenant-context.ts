import { db } from "@/lib/db";
import type { MembershipScope } from "@/lib/access-control";

export type TenantContext = {
  userId: string;
  organizationId: string;
  organizationSlug: string;
  scope: MembershipScope;
};

export async function loadTenantContext(
  userId: string,
  organizationId: string,
): Promise<TenantContext | null> {
  const membership = await db.organizationMembership.findUnique({
    where: {
      organizationId_userId: { organizationId, userId },
    },
    include: {
      organization: { select: { slug: true, active: true } },
      user: { select: { active: true } },
      siteMemberships: { select: { siteId: true } },
    },
  });

  if (
    !membership ||
    !membership.active ||
    !membership.organization.active ||
    !membership.user.active
  ) {
    return null;
  }

  return {
    userId,
    organizationId,
    organizationSlug: membership.organization.slug,
    scope: {
      active: true,
      role: membership.role,
      allSites: membership.allSites,
      siteIds: membership.siteMemberships.map(({ siteId }) => siteId),
    },
  };
}
