import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  teamMembershipFindMany: vi.fn(),
  workOrderCount: vi.fn(),
  workOrderFindMany: vi.fn(),
}));

vi.mock("@/lib/permissions", () => ({ can: mocks.can }));
vi.mock("@/lib/db", () => ({
  db: {
    maintenanceTeamMember: { findMany: mocks.teamMembershipFindMany },
    workOrder: {
      count: mocks.workOrderCount,
      findMany: mocks.workOrderFindMany,
    },
  },
}));

import { buildPersonalDashboard } from "@/lib/dashboard/personal";

describe("personal dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockReturnValue(true);
    mocks.teamMembershipFindMany.mockResolvedValue([{ teamId: "team-a" }, { teamId: "team-b" }]);
    mocks.workOrderCount
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);
    mocks.workOrderFindMany.mockResolvedValue([]);
  });

  it("scopes work to the selected tenant/site and the user or their teams", async () => {
    const result = await buildPersonalDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-1",
      role: "MAINTENANCE_MANAGER",
      now: new Date("2026-08-08T08:00:00.000Z"),
    });

    expect(result).toMatchObject({
      teamCount: 2,
      openCount: 7,
      overdueCount: 2,
      dueSoonCount: 3,
      unscheduledCount: 1,
    });
    expect(mocks.teamMembershipFindMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        team: {
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
        },
      },
      select: { teamId: true },
    });

    const firstCount = mocks.workOrderCount.mock.calls[0]?.[0];
    expect(firstCount?.where).toMatchObject({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      OR: [{ assigneeId: "user-1" }, { teamId: { in: ["team-a", "team-b"] } }],
    });
    expect(mocks.workOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ assigneeId: "user-1" }, { teamId: { in: ["team-a", "team-b"] } }],
        }),
        take: 12,
      }),
    );
  });

  it("falls back to direct assignment when the user belongs to no maintenance team", async () => {
    mocks.teamMembershipFindMany.mockResolvedValue([]);

    await buildPersonalDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-1",
      role: "TECHNICIAN",
    });

    expect(mocks.workOrderCount.mock.calls[0]?.[0]?.where).toMatchObject({
      assigneeId: "user-1",
    });
    expect(mocks.workOrderCount.mock.calls[0]?.[0]?.where.OR).toBeUndefined();
  });

  it("does not query teams or work orders without work:read", async () => {
    mocks.can.mockReturnValue(false);

    const result = await buildPersonalDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-1",
      role: "VIEWER",
    });

    expect(result).toEqual({
      teamCount: 0,
      openCount: 0,
      overdueCount: 0,
      dueSoonCount: 0,
      unscheduledCount: 0,
      workOrders: [],
    });
    expect(mocks.teamMembershipFindMany).not.toHaveBeenCalled();
    expect(mocks.workOrderCount).not.toHaveBeenCalled();
    expect(mocks.workOrderFindMany).not.toHaveBeenCalled();
  });
});
