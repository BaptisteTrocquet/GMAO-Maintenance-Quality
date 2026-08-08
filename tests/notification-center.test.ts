import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  workOrderFindMany: vi.fn(),
  reminderFindMany: vi.fn(),
  getReorderAlerts: vi.fn(),
}));

vi.mock("@/lib/permissions", () => ({ can: mocks.can }));
vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findMany: mocks.workOrderFindMany },
    maintenanceReminder: { findMany: mocks.reminderFindMany },
  },
}));
vi.mock("@/lib/inventory/reorder", () => ({ getReorderAlerts: mocks.getReorderAlerts }));

import { buildNotificationCenter } from "@/lib/notifications/center";

const now = new Date("2026-08-08T08:00:00.000Z");

describe("notification center", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockImplementation((_role: string, permission: string) => permission === "work:read");
    mocks.workOrderFindMany.mockResolvedValue([]);
    mocks.reminderFindMany.mockResolvedValue([]);
    mocks.getReorderAlerts.mockResolvedValue([]);
  });

  it("orders overdue work ahead of due-soon work and deduplicates matching reminders", async () => {
    mocks.workOrderFindMany.mockResolvedValue([
      {
        id: "wo-overdue",
        number: "WO-0001",
        title: "Inspect generic pump",
        status: "IN_PROGRESS",
        priority: "NORMAL",
        dueAt: new Date("2026-08-07T08:00:00.000Z"),
        updatedAt: new Date("2026-08-07T09:00:00.000Z"),
        asset: { code: "EQ-001" },
      },
      {
        id: "wo-soon",
        number: "WO-0002",
        title: "Check generic fan",
        status: "PLANNED",
        priority: "NORMAL",
        dueAt: new Date("2026-08-10T08:00:00.000Z"),
        updatedAt: new Date("2026-08-07T10:00:00.000Z"),
        asset: null,
      },
    ]);
    mocks.reminderFindMany.mockResolvedValue([
      {
        id: "reminder-duplicate",
        title: "WO-0002 · Check generic fan",
        assetCode: null,
        dueAt: new Date("2026-08-10T08:00:00.000Z"),
        remindAt: new Date("2026-08-03T08:00:00.000Z"),
        workOrderId: "wo-soon",
      },
      {
        id: "reminder-standalone",
        title: "WO-0003 · Lubricate generic drive",
        assetCode: "EQ-003",
        dueAt: new Date("2026-08-20T08:00:00.000Z"),
        remindAt: new Date("2026-08-08T07:00:00.000Z"),
        workOrderId: "wo-standalone",
      },
    ]);

    const items = await buildNotificationCenter({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
      now,
    });

    expect(items.map((item) => item.key)).toEqual([
      "work:wo-overdue:overdue",
      "work:wo-soon:due",
      "reminder:reminder-standalone",
    ]);
    expect(items[0]).toMatchObject({ kind: "WORK_OVERDUE", severity: "CRITICAL" });
    expect(items[1]).toMatchObject({ kind: "WORK_DUE_SOON", severity: "WARNING" });
  });

  it("does not query inventory alerts without inventory:read", async () => {
    await buildNotificationCenter({
      organizationId: "org-a",
      siteId: "site-a",
      role: "TECHNICIAN",
      now,
    });

    expect(mocks.getReorderAlerts).not.toHaveBeenCalled();
  });

  it("includes reorder alerts only when inventory is readable", async () => {
    mocks.can.mockImplementation((_role: string, permission: string) => permission === "inventory:read");
    mocks.getReorderAlerts.mockResolvedValue([
      {
        policy: { id: "policy-1" },
        status: "OUT_OF_STOCK",
        available: 0,
        part: { sku: "SP-001", name: "Generic seal", unit: "EA" },
        bin: { code: "A01", warehouse: { code: "MAIN" } },
      },
    ]);

    const items = await buildNotificationCenter({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
      now,
    });

    expect(mocks.workOrderFindMany).not.toHaveBeenCalled();
    expect(items).toEqual([
      expect.objectContaining({
        key: "reorder:policy-1",
        kind: "REORDER",
        severity: "CRITICAL",
        href: "/inventory",
      }),
    ]);
  });
});
