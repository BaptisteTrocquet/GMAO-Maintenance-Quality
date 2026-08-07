import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  membershipFindMany: vi.fn(),
  teamFindFirst: vi.fn(),
  teamCreate: vi.fn(),
  teamFindMany: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    organizationMembership: { findMany: mocks.membershipFindMany },
    maintenanceTeam: {
      findFirst: mocks.teamFindFirst,
      create: mocks.teamCreate,
      findMany: mocks.teamFindMany,
    },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { POST } from "@/app/api/maintenance-teams/route";

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

function request(memberIds = ["tech-1"]) {
  return new Request("http://localhost/api/maintenance-teams", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      code: "MECH",
      name: "Mechanical Team",
      memberIds,
    }),
  });
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("maintenance teams API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.membershipFindMany.mockResolvedValue([{ userId: "tech-1" }]);
    mocks.teamFindFirst.mockResolvedValue(null);
    mocks.teamCreate.mockResolvedValue({
      id: "team-1",
      siteId: "site-a",
      code: "MECH",
      name: "Mechanical Team",
      members: [{ userId: "tech-1", user: { id: "tech-1", displayName: "Demo Technician" } }],
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("creates a site-scoped team from active maintenance members", async () => {
    const response = await POST(request());

    await expectStatus(response, 201);
    expect(mocks.membershipFindMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organizationId: "org-a",
        userId: { in: ["tech-1"] },
        active: true,
      }),
      select: { userId: true },
    });
    expect(mocks.teamCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        siteId: "site-a",
        code: "MECH",
        name: "Mechanical Team",
        members: { create: [{ userId: "tech-1" }] },
      }),
      include: { members: { include: { user: { select: { id: true, displayName: true } } } } },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CREATED", entityType: "MaintenanceTeam" }),
    });
  });

  it("rejects a member without valid maintenance access to the site", async () => {
    mocks.membershipFindMany.mockResolvedValue([]);

    const response = await POST(request());

    await expectStatus(response, 400);
    expect(mocks.teamCreate).not.toHaveBeenCalled();
  });

  it("rejects a duplicate team code within the site", async () => {
    mocks.teamFindFirst.mockResolvedValue({ id: "team-existing" });

    const response = await POST(request());

    await expectStatus(response, 409);
    expect(mocks.teamCreate).not.toHaveBeenCalled();
  });
});
