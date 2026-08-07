import type { MembershipRole } from "@prisma/client";

export type Permission =
  | "organization:manage"
  | "site:manage"
  | "member:manage"
  | "asset:read"
  | "asset:write"
  | "work:read"
  | "work:create"
  | "work:update"
  | "work:manage"
  | "maintenance:read"
  | "maintenance:manage"
  | "inventory:read"
  | "inventory:manage"
  | "document:read"
  | "document:manage"
  | "document:approve"
  | "quality:read"
  | "quality:manage";

const permissions: Record<MembershipRole, readonly (Permission | "*")[]> = {
  OWNER: ["*"],
  ADMIN: ["*"],
  MAINTENANCE_MANAGER: [
    "site:manage",
    "asset:read",
    "asset:write",
    "work:read",
    "work:create",
    "work:update",
    "work:manage",
    "maintenance:read",
    "maintenance:manage",
    "inventory:read",
    "inventory:manage",
    "document:read",
  ],
  TECHNICIAN: [
    "asset:read",
    "work:read",
    "work:create",
    "work:update",
    "maintenance:read",
    "inventory:read",
    "document:read",
  ],
  QUALITY_MANAGER: [
    "asset:read",
    "work:read",
    "document:read",
    "document:manage",
    "document:approve",
    "quality:read",
    "quality:manage",
  ],
  OPERATOR: ["asset:read", "work:read", "work:create", "document:read"],
  VIEWER: ["asset:read", "work:read", "document:read", "quality:read"],
};

export function can(role: MembershipRole, permission: Permission): boolean {
  const granted = permissions[role];
  return granted.includes("*") || granted.includes(permission);
}
