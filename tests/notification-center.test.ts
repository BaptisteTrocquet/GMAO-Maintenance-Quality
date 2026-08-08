import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workOrderFindMany: vi.fn(),
  listReminders: vi.fn(),
  getReorderAlerts: vi.fn(),
  listQualityEvents: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { workOrder: { findMany: mocks.workOrderFindMany } } }));
vi.mock("@/lib/maintenance/reminders", () => ({ listActiveMaintenanceReminders: mocks.listReminders }));
vi.mock("@/lib/inventory/reorder", () => ({ getReorderAlerts: mocks.getReorderAlerts }));
vi.mock("@/lib/quality/events", () => ({ listQualityEvents: mocks.listQualityEvents }));

import { buildNotificationCenter } from "@/lib/notifications/center";

const now = new Date("2026-08-08T10:00:00.000Z");

describe("notification center", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workOrderFindMany.mockResolvedValue([]);
    mocks.listReminders.mockResolvedValue([]);
    mocks.getReorderAlerts.mockResolvedValue([]);
    mocks.listQualityEvents.mockResolvedValue([]);
  });

  it("queries only domains permitted for a maintenance manager", async () => {
    await buildNotificationCenter({ organizationId: "org-a", siteId: "site-a", role: "MAINTENANCE_MANAGER", now });

    expect(mocks.workOrderFindMany).toHaveBeenCalled();
    expect(mocks.listReminders).toHaveBeenCalledWith({ organizationId: "org-a", siteId: "site-a" });
    expect(mocks.getReorderAlerts).toHaveBeenCalledWith({ organizationId: "org-a", siteId: "site-a" });
    expect(mocks.listQualityEvents).not.toHaveBeenCalled();
  });

  it("does not query inventory for a viewer but can surface quality alerts", async () => {
    mocks.listQualityEvents.mockResolvedValue([
      {
        id: "qe-1",
        eventNumber: "QE-001",
        type: "COMPLAINT",
        severity: "CRITICAL",
        status: "OPEN",
        title: "Synthetic complaint",
        updatedAt: "2026-08-08T09:00:00.000Z",
      },
    ]);

    const result = await buildNotificationCenter({ organizationId: "org-a", siteId: "site-a", role: "VIEWER", now });

    expect(mocks.getReorderAlerts).not.toHaveBeenCalled();
    expect(result.items).toEqual([
      expect.objectContaining({ kind: "QUALITY_ALERT", severity: "CRITICAL", sourceId: "qe-1" }),
    ]);
  });

  it("scopes overdue work orders to the selected active organization and site", async () => {
    await buildNotificationCenter({ organizationId: "org-a", siteId: "site-a", role: "MAINTENANCE_MANAGER", now });

    expect(mocks.workOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
          dueAt: { lt: now },
        }),
        take: 30,
      }),
    );
  });

  it("sorts critical items first and returns bounded severity counts", async () => {
    mocks.workOrderFindMany.mockResolvedValue([
      {
        id: "wo-high",
        number: "WO-001",
        title: "High priority overdue",
        priority: "HIGH",
        dueAt: new Date("2026-08-07T08:00:00.000Z"),
        assignee: null,
        team: null,
      },
    ]);
    mocks.getReorderAlerts.mockResolvedValue([
      {
        policy: { id: "policy-1" },
        status: "OUT_OF_STOCK",
        part: { sku: "SP-001", name: "Synthetic spare", unit: "EA" },
        available: 0,
        suggestedOrderQuantity: 4,
        bin: { code: "B01", warehouse: { code: "WH1" } },
      },
    ]);

    const result = await buildNotificationCenter({ organizationId: "org-a", siteId: "site-a", role: "MAINTENANCE_MANAGER", now });

    expect(result.items.map((item) => item.severity)).toEqual(["CRITICAL", "HIGH"]);
    expect(result.counts).toEqual({ total: 2, critical: 1, high: 1, normal: 0 });
  });
});
