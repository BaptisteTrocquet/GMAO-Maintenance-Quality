import type { MembershipRole } from "@prisma/client";
import { can, type Permission } from "@/lib/permissions";

export class AccessDeniedError extends Error {
  constructor(message = "Access denied") {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export type MembershipScope = {
  active: boolean;
  role: MembershipRole;
  allSites: boolean;
  siteIds: readonly string[];
};

export function hasSiteAccess(scope: MembershipScope, siteId: string): boolean {
  if (!scope.active) return false;
  if (scope.allSites) return true;
  return scope.siteIds.includes(siteId);
}

export function assertPermission(scope: MembershipScope, permission: Permission): void {
  if (!scope.active || !can(scope.role, permission)) {
    throw new AccessDeniedError();
  }
}

export function assertSitePermission(
  scope: MembershipScope,
  siteId: string,
  permission: Permission,
): void {
  assertPermission(scope, permission);

  if (!hasSiteAccess(scope, siteId)) {
    throw new AccessDeniedError("Site access denied");
  }
}
