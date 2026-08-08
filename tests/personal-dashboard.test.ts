import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workCount: vi.fn(),
  workFindMany: vi.fn(),
  approvalCount: vi.fn(),
  approvalFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { count: mocks.workCount, findMany: mocks.workFindMany },
    documentApproval: { count: mocks.approvalCount, findMany: mocks.approvalFindMany },
  },
}));

import { buildPersonalDashboard } from "@/lib/dashboard/personal";

const now = new Date("2026-08-08T10:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workCount.mockResolvedValue(0);
  mocks.workFindMany.mockResolvedValue([]);
  mocks.approvalCount.mockResolvedValue(0);
  mocks.approvalFindMany.mockResolvedValue([]);
});

describe("personal dashboard", () => {
  it("scopes work to the selected tenant/site, direct assignments, or unassigned team work", async () => {
    await buildPersonalDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      role: "MAINTENANCE_MANAGER",
      now,
    });

    expect(mocks.workFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          OR: [
            { assigneeId: "user-a" },
            {
              assigneeId: null,
              team: { members: { some: { userId: "user-a" } } },
            },
          ],
        },
      }),
    );
  });

  it("scopes pending approvals to the authenticated user and organization", async () => {
    await buildPersonalDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      role: "QUALITY_MANAGER",
      now,
    });

    expect(mocks.approvalCount).toHaveBeenCalledWith({
      where: {
        approverId: "user-a",
        decision: "PENDING",
        revision: { document: { organizationId: "org-a" } },
      },
    });
    expect(mocks.approvalFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          approverId: "user-a",
          decision: "PENDING",
          revision: { document: { organizationId: "org-a" } },
        },
      }),
    );
  });

  it("does not query document approvals for a technician without document:approve", async () => {
    await buildPersonalDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "tech-a",
      role: "TECHNICIAN",
      now,
    });

    expect(mocks.workFindMany).toHaveBeenCalled();
    expect(mocks.approvalCount).not.toHaveBeenCalled();
    expect(mocks.approvalFindMany).not.toHaveBeenCalled();
  });

  it("returns exact counters independently from the bounded top-work list", async () => {
    mocks.workCount
      .mockResolvedValueOnce(24)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2);
    mocks.approvalCount.mockResolvedValue(4);
    mocks.workFindMany.mockResolvedValue([{ id: "wo-1" }]);

    const result = await buildPersonalDashboard({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      role: "QUALITY_MANAGER",
      now,
    });

    expect(result.metrics).toEqual({
      openWork: 24,
      blockedWork: 3,
      overdueWork: 5,
      dueSoonWork: 7,
      urgentWork: 2,
      pendingApprovals: 4,
    });
    expect(result.workOrders).toHaveLength(1);
  });
});
