import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workOrderFindMany: vi.fn(),
  reminderFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findMany: mocks.workOrderFindMany },
    maintenanceReminder: { findMany: mocks.reminderFindMany },
  },
}));

import { buildPersonalMaintenanceDashboard } from "@/lib/maintenance/personal-dashboard";

const NOW = new Date("2026-08-08T08:00:00.000Z");

describe("personal maintenance dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workOrderFindMany.mockResolvedValue([]);
    mocks.reminderFindMany.mockResolvedValue([]);
  });

  it("scopes work to the selected tenant/site and direct-or-team ownership", async () => {
    await buildPersonalMaintenanceDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      role: "TECHNICIAN",
      now: NOW,
    });

    expect(mocks.workOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          OR: [
            { assigneeId: "user-a" },
            { assigneeId: null, team: { members: { some: { userId: "user-a" } } } },
          ],
        },
        take: 30,
      }),
    );
  });

  it("labels direct and team work without double-counting one work order", async () => {
    mocks.workOrderFindMany.mockResolvedValue([
      {
        id: "wo-direct",
        number: "WO-001",
        title: "Direct work",
        status: "IN_PROGRESS",
        priority: "HIGH",
        plannedStart: new Date("2026-08-08T06:00:00.000Z"),
        dueAt: new Date("2026-08-08T12:00:00.000Z"),
        assigneeId: "user-a",
        asset: { code: "A-01" },
        team: { name: "Team A" },
      },
      {
        id: "wo-team",
        number: "WO-002",
        title: "Team work",
        status: "BLOCKED",
        priority: "NORMAL",
        plannedStart: null,
        dueAt: new Date("2026-08-07T12:00:00.000Z"),
        assigneeId: null,
        asset: null,
        team: { name: "Team A" },
      },
    ]);

    const result = await buildPersonalMaintenanceDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      role: "TECHNICIAN",
      now: NOW,
    });

    expect(result.workOrders.map((item) => [item.id, item.ownership])).toEqual([
      ["wo-direct", "ASSIGNED"],
      ["wo-team", "TEAM"],
    ]);
    expect(result.counts).toMatchObject({
      active: 2,
      overdue: 1,
      dueSoon: 1,
      blocked: 1,
      inProgress: 1,
    });
  });

  it("loads preventive reminders only when maintenance:read is granted", async () => {
    await buildPersonalMaintenanceDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      role: "TECHNICIAN",
      now: NOW,
    });
    expect(mocks.reminderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
          status: "ACTIVE",
          workOrder: expect.objectContaining({
            OR: [
              { assigneeId: "user-a" },
              { assigneeId: null, team: { members: { some: { userId: "user-a" } } } },
            ],
          }),
        }),
        take: 20,
      }),
    );
  });

  it("returns empty without querying when role lacks work:read", async () => {
    const result = await buildPersonalMaintenanceDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      role: "OPERATOR",
      now: NOW,
    });

    expect(result.workOrders).toEqual([]);
    expect(mocks.workOrderFindMany).not.toHaveBeenCalled();
    expect(mocks.reminderFindMany).not.toHaveBeenCalled();
  });
});
