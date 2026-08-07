import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  workOrderFindFirst: vi.fn(),
  workOrderUpdate: vi.fn(),
  membershipFindFirst: vi.fn(),
  teamFindFirst: vi.fn(),
  teamMemberFindFirst: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst, update: mocks.workOrderUpdate },
    organizationMembership: { findFirst: mocks.membershipFindFirst },
    maintenanceTeam: { findFirst: mocks.teamFindFirst },
    maintenanceTeamMember: { findFirst: mocks.teamMemberFindFirst },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { PATCH } from "@/app/api/work-orders/[workOrderId]/route";

const auth = {
  session: { user: { id: "manager-1" } },
  tenant: {
    scope: {
      organizationId: "org-a",
      role: "MAINTENANCE_MANAGER",
      allSites: true,
      siteIds: [],
      active: true,
    },
  },
};

const existing = {
  id: "wo-1",
  number: "WO-000001",
  siteId: "site-a",
  assetId: null,
  requesterId: "requester-1",
  assigneeId: null,
  teamId: null,
  title: "Inspect utility area",
  description: null,
  type: "CORRECTIVE",
  status: "APPROVED",
  priority: "NORMAL",
  requestedAt: new Date("2026-08-07T08:00:00.000Z"),
  plannedStart: null,
  dueAt: null,
  startedAt: null,
  completedAt: null,
  downtimeMinutes: null,
  laborMinutes: null,
  completionNote: null,
  createdAt: new Date("2026-08-07T08:00:00.000Z"),
  updatedAt: new Date("2026-08-07T08:00:00.000Z"),
  checkItems: [],
};

function request(teamId: string | null) {
  return new Request("http://localhost/api/work-orders/wo-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", teamId }),
  });
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("work order team assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.workOrderFindFirst.mockResolvedValue(existing);
    mocks.teamFindFirst.mockResolvedValue({ id: "team-1" });
    mocks.workOrderUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...existing,
      ...data,
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("assigns an active maintenance team from the same site", async () => {
    const response = await PATCH(request("team-1"), params);

    await expectStatus(response, 200);
    expect(mocks.teamFindFirst).toHaveBeenCalledWith({
      where: { id: "team-1", siteId: "site-a", active: true },
      select: { id: true },
    });
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: { teamId: "team-1" },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "TRIAGED", actorId: "manager-1" }),
    });
  });

  it("rejects a team outside the work-order site", async () => {
    mocks.teamFindFirst.mockResolvedValue(null);

    const response = await PATCH(request("team-foreign"), params);

    await expectStatus(response, 404);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("allows clearing the team assignment", async () => {
    const response = await PATCH(request(null), params);

    await expectStatus(response, 200);
    expect(mocks.teamFindFirst).not.toHaveBeenCalled();
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: { teamId: null },
    });
  });
});
