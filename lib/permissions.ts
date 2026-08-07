export type AppRole = "ADMIN" | "MAINTENANCE_MANAGER" | "TECHNICIAN" | "REQUESTER" | "DOCUMENT_CONTROLLER" | "APPROVER" | "VIEWER";

const permissions: Record<AppRole, string[]> = {
  ADMIN: ["*"],
  MAINTENANCE_MANAGER: ["asset:*", "work:*", "maintenance:*", "inventory:*", "document:read"],
  TECHNICIAN: ["asset:read", "work:read", "work:update", "maintenance:read", "inventory:read", "document:read"],
  REQUESTER: ["asset:read", "work:create", "work:read", "document:read"],
  DOCUMENT_CONTROLLER: ["document:*", "asset:read"],
  APPROVER: ["document:read", "document:approve"],
  VIEWER: ["asset:read", "work:read", "document:read"]
};

export function can(role: AppRole, permission: string) {
  const p = permissions[role] ?? [];
  return p.includes("*") || p.includes(permission) || p.some(x => x.endsWith(":*") && permission.startsWith(x.slice(0, -1)));
}
