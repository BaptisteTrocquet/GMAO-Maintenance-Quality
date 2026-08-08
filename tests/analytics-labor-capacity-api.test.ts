import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  return {
    AccessDeniedError,
    authenticateRequest: vi.fn(),
    assertSitePermission: vi.fn(),
    siteFindFirst: vi.fn(),
    membershipFindMany: vi.fn(),
    listProfiles: vi.fn(),
    setProfile: vi.fn(),
    disableProfile: vi.fn(),
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    organizationMembership: { findMany: mocks.membershipFindMany },
  },
}));
vi.mock("@/lib/analytics/labor-capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/labor-capacity")>();
  return {
    ...actual,
    listLaborCapacityProfiles: mocks.listProfiles,
    setLaborCapacityProfile: mocks.setProfile,
    disableLaborCapacityProfile: mocks.disableProfile,
  };
});

import { GET, PATCH } from "@/app/api/analytics/labor-capacity/route";

function auth() {
  return {
    session: { user: { id: "manager-a" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "MAINTENANCE_MANAGER",
        allSites: false,
        siteIds: ["site-a"],
        active: true,
      },
    },
  };
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/analytics/labor-capacity", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("labor capacity API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.membershipFindMany.mockResolvedValue([
      { user: { id: "user-a", displayName: "Synthetic Technician" } },
    ]);
    mocks.listProfiles.mockResolvedValue([
      {
        userId: "user-a",
        displayName: "Synthetic Technician",
        weeklyCapacityMinutes: 2100,
      },
    ]);
    mocks.setProfile.mockResolvedValue({ userId: "user-a", weeklyCapacityMinutes: 2100 });
    mocks.disableProfile.mockResolvedValue({ userId: "user-a", active: false });
  });

  it("returns eligible users and active profiles with maintenance read permission", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/analytics/labor-capacity?organizationId=org-a&siteId=site-a",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a" }),
      "site-a",
      "maintenance:read",
    );
    expect(mocks.membershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-a",
          role: { in: ["OWNER", "ADMIN", "MAINTENANCE_MANAGER", "TECHNICIAN"] },
        }),
      }),
    );
  });

  it("requires maintenance manage permission before updating a baseline", async () => {
    const response = await PATCH(
      patchRequest({
        organizationId: "org-a",
        siteId: "site-a",
        userId: "user-a",
        weeklyCapacityMinutes: 2100,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a" }),
      "site-a",
      "maintenance:manage",
    );
    expect(mocks.setProfile).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      weeklyCapacityMinutes: 2100,
      actorId: "manager-a",
    });
  });

  it("uses null capacity as an explicit disable action", async () => {
    const response = await PATCH(
      patchRequest({
        organizationId: "org-a",
        siteId: "site-a",
        userId: "user-a",
        weeklyCapacityMinutes: null,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.disableProfile).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      actorId: "manager-a",
    });
    expect(mocks.setProfile).not.toHaveBeenCalled();
  });

  it("returns access denied without mutating capacity", async () => {
    mocks.assertSitePermission.mockImplementation(() => {
      throw new mocks.AccessDeniedError("Missing permission");
    });

    const response = await PATCH(
      patchRequest({
        organizationId: "org-a",
        siteId: "site-a",
        userId: "user-a",
        weeklyCapacityMinutes: 2100,
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.setProfile).not.toHaveBeenCalled();
    expect(mocks.disableProfile).not.toHaveBeenCalled();
  });

  it("rejects an invalid capacity before authentication", async () => {
    const response = await PATCH(
      patchRequest({
        organizationId: "org-a",
        siteId: "site-a",
        userId: "user-a",
        weeklyCapacityMinutes: -1,
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
