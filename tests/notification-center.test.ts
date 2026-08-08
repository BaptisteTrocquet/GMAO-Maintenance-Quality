import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workOrderFindMany: vi.fn(),
  reminderFindMany: vi.fn(),
  getReorderAlerts: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findMany: mocks.workOrderFindMany },
    maintenanceReminder: { findMany: mocks.reminderFindMany },
  },
}));

vi.mock("@/lib/inventory/reorder", () => ({
  getReorderAlerts: mocks.getReorderAlerts,
}));

import { buildNotificationCenter } from "@/lib/notifications/center";

const now = new Date("2026-08-08T10:00:00.000Z");

describe("notification center", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workOrderFindMany.mockResolvedValue([]);
    mocks.reminderFindMany.mockResolvedValue([]);
    mocks.getReorderAlerts.mockResolvedValue([]);
  });

  it("does not query inventory for a viewer without inventory:read", async () => {
    await buildNotificationCenter({
      organizationId: "org-a",
      siteId: "site-a",
      role: "VIEWER",
      now,
    });

    expect(mocks.workOrderFindMany).toHaveBeenCalled();
    expect(mocks.reminderFindMany).toHaveBeenCalled();
    expect(mocks.getReorderAlerts).not.toHaveBeenCalled();
  });

  it("scopes active work and reminders to the selected site and organization", async () => {
    await buildNotificationCenter({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
      now,
    });

    expect(mocks.workOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
        }),
      }),
    );
    expect(mocks.reminderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
        }),
      }),
    );
    expect(mocks.getReorderAlerts).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
    });
  });

  it("deduplicates a reminder when the same work order already has a due notification", async () => {
    mocks.workOrderFindMany.mockResolvedValue([
      {
        id: "wo-1",
        number: "WO-001",
        title: "Synthetic inspection",
        status: "PLANNED",
        priority: "NORMAL",
        dueAt: new Date("2026-08-10T10:00:00.000Z"),
        updatedAt: now,
        asset: { code: "ASSET-001" },
      },
    ]);
    mocks.reminderFindMany.mockResolvedValue([
      {
        id: "reminder-1",
        title: "WO-001 · Synthetic inspection",
        assetCode: "ASSET-001",
        dueAt: new Date("2026-08-10T10:00:00.000Z"),
        remindAt: now,
        workOrderId: "wo-1",
      },
    ]);

    const items = await buildNotificationCenter({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
      now,
    });

    expect(items.filter((item) => item.href === "/maintenance/wo-1")).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "WORK_DUE_SOON", key: "work:wo-1:due" });
  });

  it("sorts critical overdue and out-of-stock signals ahead of warnings", async () => {
    mocks.workOrderFindMany.mockResolvedValue([
      {
        id: "overdue",
        number: "WO-OVER",
        title: "Overdue work",
        status: "IN_PROGRESS",
        priority: "NORMAL",
        dueAt: new Date("2026-08-07T10:00:00.000Z"),
        updatedAt: now,
        asset: null,
      },
      {
        id: "future",
        number: "WO-FUTURE",
        title: "Upcoming work",
        status: "PLANNED",
        priority: "NORMAL",
        dueAt: new Date("2026-08-09T10:00:00.000Z"),
        updatedAt: now,
        asset: null,
      },
    ]);
    mocks.getReorderAlerts.mockResolvedValue([
      {
        policy: { id: "policy-1" },
        part: { sku: "SP-001", name: "Synthetic spare", unit: "EA" },
        available: 0,
        status: "OUT_OF_STOCK",
        bin: { code: "B01", warehouse: { code: "WH1" } },
      },
    ]);

    const items = await buildNotificationCenter({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
      now,
    });

    expect(items.slice(0, 2).map((item) => item.severity)).toEqual(["CRITICAL", "CRITICAL"]);
    expect(items.at(-1)?.kind).toBe("WORK_DUE_SOON");
  });
});
