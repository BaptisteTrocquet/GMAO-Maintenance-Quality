import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auditCount: vi.fn(), auditCreate: vi.fn(), workOrderCount: vi.fn(), assetCount: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { auditLog: { count: mocks.auditCount, create: mocks.auditCreate }, workOrder: { count: mocks.workOrderCount }, asset: { count: mocks.assetCount } } }));

import { getPublicKpiCard } from "@/lib/public-kpis/card";

const token = { id: "token-kpi", siteId: "site-a" };

describe("public KPI card service", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.auditCount.mockResolvedValue(0); mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.workOrderCount.mockResolvedValueOnce(12).mockResolvedValueOnce(3).mockResolvedValueOnce(4); mocks.assetCount.mockResolvedValue(2);
  });

  it("returns only aggregate counts scoped to the token site", async () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    const result = await getPublicKpiCard({ token, now });
    expect(result).toEqual({ openWorkOrders: 12, overdueWorkOrders: 3, inProgressWorkOrders: 4, outOfServiceAssets: 2, generatedAt: now });
    expect(mocks.workOrderCount).toHaveBeenNthCalledWith(1, { where: { siteId: "site-a", status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] } } });
    expect(mocks.workOrderCount).toHaveBeenNthCalledWith(2, { where: { siteId: "site-a", status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] }, dueAt: { lt: now } } });
    expect(mocks.workOrderCount).toHaveBeenNthCalledWith(3, { where: { siteId: "site-a", status: "IN_PROGRESS" } });
    expect(mocks.assetCount).toHaveBeenCalledWith({ where: { siteId: "site-a", status: "OUT_OF_SERVICE", archivedAt: null } });
    expect(Object.keys(result).sort()).toEqual(["generatedAt", "inProgressWorkOrders", "openWorkOrders", "outOfServiceAssets", "overdueWorkOrders"].sort());
  });

  it("rate limits before running aggregate queries", async () => {
    vi.clearAllMocks(); mocks.auditCount.mockResolvedValue(120);
    await expect(getPublicKpiCard({ token })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(mocks.workOrderCount).not.toHaveBeenCalled(); expect(mocks.assetCount).not.toHaveBeenCalled();
  });
});
