import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workOrderFindMany: vi.fn(),
  reminderFindMany: vi.fn(),
  auditFindMany: vi.fn(),
  getReorderAlerts: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findMany: mocks.workOrderFindMany },
    maintenanceReminder: { findMany: mocks.reminderFindMany },
    auditLog: { findMany: mocks.auditFindMany },
  },
}));
vi.mock("@/lib/inventory/reorder", () => ({ getReorderAlerts: mocks.getReorderAlerts }));

import {
  buildNotificationCenter,
  NOTIFICATION_CENTER_LIMIT,
} from "@/lib/notifications/center";

const now = new Date("2026-08-08T10:00:00.000Z");

describe("notification center final bound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reminderFindMany.mockResolvedValue([]);
    mocks.workOrderFindMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        id: `wo-${index}`,
        number: `WO-${String(index).padStart(3, "0")}`,
        title: "Synthetic overdue work",
        priority: "HIGH",
        dueAt: new Date(`2026-08-07T${String(index % 24).padStart(2, "0")}:00:00.000Z`),
        assignee: null,
        team: null,
      })),
    );
    mocks.getReorderAlerts.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => ({
        policy: { id: `policy-${index}` },
        status: "REORDER",
        part: { sku: `SP-${index}`, name: "Synthetic spare", unit: "EA" },
        available: 1,
        suggestedOrderQuantity: 4,
        bin: { code: "B01", warehouse: { code: "WH1" } },
      })),
    );
    mocks.auditFindMany.mockResolvedValue(
      Array.from({ length: 31 }, (_, index) => ({
        entityId: `qe-${index}`,
        afterJson: JSON.stringify({
          id: `qe-${index}`,
          eventNumber: `QE-${String(index).padStart(3, "0")}`,
          organizationId: "org-a",
          siteId: "site-a",
          type: "COMPLAINT",
          severity: "HIGH",
          status: "OPEN",
          title: "Synthetic quality alert",
          updatedAt: `2026-08-08T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
        }),
      })),
    );
  });

  it("caps the composed feed and reports truncation after combining permitted domains", async () => {
    const result = await buildNotificationCenter({
      organizationId: "org-a",
      siteId: "site-a",
      role: "OWNER",
      now,
    });

    expect(result.items).toHaveLength(NOTIFICATION_CENTER_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.counts.total).toBe(NOTIFICATION_CENTER_LIMIT);
  });
});
