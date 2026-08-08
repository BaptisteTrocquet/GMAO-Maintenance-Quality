import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  hasSiteAccess: vi.fn(),
  siteFindFirst: vi.fn(),
  buildNotificationCenter: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({ hasSiteAccess: mocks.hasSiteAccess }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/notifications/center", () => ({
  buildNotificationCenter: mocks.buildNotificationCenter,
}));

import { GET } from "@/app/api/notifications/route";

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

describe("notification center API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.hasSiteAccess.mockReturnValue(true);
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.buildNotificationCenter.mockResolvedValue([]);
  });

  it("passes authenticated role and tenant scope to the aggregator", async () => {
    const response = await GET(
      new Request("http://localhost/api/notifications?organizationId=org-a&siteId=site-a"),
    );

    expect(response.status).toBe(200);
    expect(mocks.buildNotificationCenter).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
    });
  });

  it("fails closed when the membership cannot access the requested site", async () => {
    mocks.hasSiteAccess.mockReturnValue(false);

    const response = await GET(
      new Request("http://localhost/api/notifications?organizationId=org-a&siteId=site-b"),
    );

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildNotificationCenter).not.toHaveBeenCalled();
  });

  it("does not reveal a site outside the requested organization", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/notifications?organizationId=org-a&siteId=site-b"),
    );

    expect(response.status).toBe(404);
    expect(mocks.buildNotificationCenter).not.toHaveBeenCalled();
  });

  it("requires both organization and site scope", async () => {
    const response = await GET(new Request("http://localhost/api/notifications?organizationId=org-a"));

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
