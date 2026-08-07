import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  teamMemberFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    maintenanceTeamMember: { findFirst: mocks.teamMemberFindFirst },
  },
}));

import { canExecuteWorkOrder } from "@/lib/work-orders/authorization";

describe("work order executor authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets a maintenance manager execute without team lookup", async () => {
    await expect(
      canExecuteWorkOrder({
        role: "MAINTENANCE_MANAGER",
        userId: "manager-1",
        siteId: "site-a",
        assigneeId: null,
        teamId: "team-1",
      }),
    ).resolves.toBe(true);
    expect(mocks.teamMemberFindFirst).not.toHaveBeenCalled();
  });

  it("lets the directly assigned technician execute without team lookup", async () => {
    await expect(
      canExecuteWorkOrder({
        role: "TECHNICIAN",
        userId: "tech-1",
        siteId: "site-a",
        assigneeId: "tech-1",
        teamId: null,
      }),
    ).resolves.toBe(true);
    expect(mocks.teamMemberFindFirst).not.toHaveBeenCalled();
  });

  it("lets an active member of the assigned site team execute", async () => {
    mocks.teamMemberFindFirst.mockResolvedValue({ teamId: "team-1" });

    await expect(
      canExecuteWorkOrder({
        role: "TECHNICIAN",
        userId: "tech-1",
        siteId: "site-a",
        assigneeId: null,
        teamId: "team-1",
      }),
    ).resolves.toBe(true);

    expect(mocks.teamMemberFindFirst).toHaveBeenCalledWith({
      where: {
        teamId: "team-1",
        userId: "tech-1",
        user: { active: true },
        team: { siteId: "site-a", active: true },
      },
      select: { teamId: true },
    });
  });

  it("rejects a technician who is neither directly assigned nor a team member", async () => {
    mocks.teamMemberFindFirst.mockResolvedValue(null);

    await expect(
      canExecuteWorkOrder({
        role: "TECHNICIAN",
        userId: "tech-1",
        siteId: "site-a",
        assigneeId: "tech-2",
        teamId: "team-1",
      }),
    ).resolves.toBe(false);
  });
});
