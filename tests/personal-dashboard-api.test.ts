import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  hasSiteAccess: vi.fn(),
  siteFindFirst: vi.fn(),
  buildPersonalDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({ hasSiteAccess: mocks.hasSiteAccess }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/dashboard/personal", () => ({ buildPersonalDashboard: mocks.buildPersonalDashboard }));

import { GET } from "@/app/api/dashboard/personal/route";

function auth() {
  return {
    session: { user: { id: "user-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "MAINTENANCE_MANAGER" as const,
        allSites: true,
        siteIds: [],
        active: true,
      },
    },
  };
}

describe("personal dashboard API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.hasSiteAccess.mockReturnValue(true);
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a", code: "SITE", name: "Demo site" });
    mocks.buildPersonalDashboard.mockResolvedValue({
      teamCount: 0,
      openCount: 0,
      overdueCount: 0,
      dueSoonCount: 0,
      unscheduledCount: 0,
      workOrders: [],
    });
  });

  it("injects the authenticated user identity into the dashboard service", async () => {
    const response = await GET(
      new Request("http://localhost/api/dashboard/personal?organizationId=org-a&siteId=site-a"),
    );

    expect(response.status).toBe(200);
    expect(mocks.buildPersonalDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-1",
      role: "MAINTENANCE_MANAGER",
    });
  });

  it("rejects inaccessible sites before reading dashboard data", async () => {
    mocks.hasSiteAccess.mockReturnValue(false);

    const response = await GET(
      new Request("http://localhost/api/dashboard/personal?organizationId=org-a&siteId=site-b"),
    );

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildPersonalDashboard).not.toHaveBeenCalled();
  });

  it("does not reveal an active site from another organization", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/dashboard/personal?organizationId=org-a&siteId=site-b"),
    );

    expect(response.status).toBe(404);
    expect(mocks.buildPersonalDashboard).not.toHaveBeenCalled();
  });

  it("requires explicit organization and site scope", async () => {
    const response = await GET(new Request("http://localhost/api/dashboard/personal?siteId=site-a"));

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
