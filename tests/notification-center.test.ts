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
  NOTIFICATION_QUALITY_SCAN_LIMIT,
  NOTIFICATION_REMINDER_LIMIT,
  NOTIFICATION_REORDER_LIMIT,
  NOTIFICATION_WORK_ORDER_LIMIT,
} from "@/lib/notifications/center";

const now = new Date("2026-08-08T10:00:00.000Z");

function qualitySnapshot(input: {
  id: string;
  eventNumber: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
  title: string;
}) {
  return JSON.stringify({
    ...input,
    organizationId: "org-a",
    siteId: "site-a",
    type: "COMPLAINT",
    updatedAt: "2026-08-08T09:00:00.000Z",
  });
}

describe("notification center", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workOrderFindMany.mockResolvedValue([]);
    mocks.reminderFindMany.mockResolvedValue([]);
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.getReorderAlerts.mockResolvedValue([]);
  });

  it("queries only domains permitted for a maintenance manager", async () => {
    await buildNotificationCenter({ organizationId: "org-a", siteId: "site-a", role: "MAINTENANCE_MANAGER", now });

    expect(mocks.workOrderFindMany).toHaveBeenCalled();
    expect(mocks.reminderFindMany).toHaveBeenCalled();
    expect(mocks.getReorderAlerts).toHaveBeenCalledWith({ organizationId: "org-a", siteId: "site-a" });
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
  });

  it("keeps work and quality visible to viewers without leaking maintenance or inventory domains", async () => {
    mocks.auditFindMany.mockResolvedValue([
      {
        entityId: "qe-1",
        afterJson: qualitySnapshot({
          id: "qe-1",
          eventNumber: "QE-001",
          severity: "CRITICAL",
          status: "OPEN",
          title: "Synthetic complaint",
        }),
      },
    ]);

    const result = await buildNotificationCenter({ organizationId: "org-a", siteId: "site-a", role: "VIEWER", now });

    expect(mocks.workOrderFindMany).toHaveBeenCalled();
    expect(mocks.auditFindMany).toHaveBeenCalled();
    expect(mocks.reminderFindMany).not.toHaveBeenCalled();
    expect(mocks.getReorderAlerts).not.toHaveBeenCalled();
    expect(result.items).toEqual([
      expect.objectContaining({ kind: "QUALITY_ALERT", severity: "CRITICAL", sourceId: "qe-1" }),
    ]);
  });

  it("scopes and bounds every direct notification query", async () => {
    await buildNotificationCenter({ organizationId: "org-a", siteId: "site-a", role: "OWNER", now });

    expect(mocks.workOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
          dueAt: { lt: now },
        }),
        take: NOTIFICATION_WORK_ORDER_LIMIT,
      }),
    );
    expect(mocks.reminderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
          status: "ACTIVE",
          remindAt: { lte: now },
          dueAt: { gte: now },
          workOrder: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
        }),
        take: NOTIFICATION_REMINDER_LIMIT,
      }),
    );
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityType: "QualityEvent",
          AND: [
            { afterJson: { contains: '"organizationId":"org-a"' } },
            { afterJson: { contains: '"siteId":"site-a"' } },
          ],
        },
        take: NOTIFICATION_QUALITY_SCAN_LIMIT,
      }),
    );
  });

  it("keeps due reminders separate from overdue work-order notifications", async () => {
    await buildNotificationCenter({ organizationId: "org-a", siteId: "site-a", role: "MAINTENANCE_MANAGER", now });

    expect(mocks.reminderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dueAt: { gte: now } }),
      }),
    );
    expect(mocks.workOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dueAt: { lt: now } }),
      }),
    );
  });

  it("uses the latest quality snapshot and ignores closed or low-severity events", async () => {
    mocks.auditFindMany.mockResolvedValue([
      {
        entityId: "qe-1",
        afterJson: qualitySnapshot({
          id: "qe-1",
          eventNumber: "QE-001",
          severity: "CRITICAL",
          status: "CLOSED",
          title: "Closed complaint",
        }),
      },
      {
        entityId: "qe-1",
        afterJson: qualitySnapshot({
          id: "qe-1",
          eventNumber: "QE-001",
          severity: "CRITICAL",
          status: "OPEN",
          title: "Stale open complaint",
        }),
      },
      {
        entityId: "qe-2",
        afterJson: qualitySnapshot({
          id: "qe-2",
          eventNumber: "QE-002",
          severity: "LOW",
          status: "OPEN",
          title: "Low observation",
        }),
      },
    ]);

    const result = await buildNotificationCenter({ organizationId: "org-a", siteId: "site-a", role: "VIEWER", now });

    expect(result.items).toEqual([]);
  });

  it("limits reorder alerts before composing the final feed", async () => {
    mocks.getReorderAlerts.mockResolvedValue(
      Array.from({ length: NOTIFICATION_REORDER_LIMIT + 5 }, (_, index) => ({
        policy: { id: `policy-${index}` },
        status: "REORDER",
        part: { sku: `SP-${index}`, name: "Synthetic spare", unit: "EA" },
        available: 1,
        suggestedOrderQuantity: 4,
        bin: { code: "B01", warehouse: { code: "WH1" } },
      })),
    );

    const result = await buildNotificationCenter({ organizationId: "org-a", siteId: "site-a", role: "MAINTENANCE_MANAGER", now });

    expect(result.items.filter((item) => item.kind === "REORDER_ALERT")).toHaveLength(
      NOTIFICATION_REORDER_LIMIT,
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
