export function buildMaintenanceSiteScope(organizationId: string, siteId?: string | null) {
  if (!organizationId) throw new Error("organizationId is required for maintenance scope");

  return {
    organizationId,
    active: true,
    ...(siteId ? { id: siteId } : {}),
  } as const;
}
