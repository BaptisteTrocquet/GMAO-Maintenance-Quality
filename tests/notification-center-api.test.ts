import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildNotificationCenter: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/notifications/center", () => ({ buildNotificationCenter: mocks.buildNotificationCenter }));

import { GET } from "@/app/api/notifications/route";

function request(siteId = "site-a") {
  const query = new URLSearchParams({ organizationId: "org-a", siteId });
  return new Request(`http://localhost/api/notifications?${query.toString()}`);
}

function auth(overrides: Record<string, unknown> = {}) {
  return {
    session: { user: { id: "user-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "VIEWER",
        allSites: false,
        siteIds: ["site-a"],
        active: true,
        ...overrides,
      },
    },
  };
}

describe("notification center API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.buildNotificationCenter.mockResolvedValue({
      items: [],
      truncated: false,
      counts: { total: 0, critical: 0, high: 0, normal: 0 },
    });
  });

  it("rejects a selected site outside membership before querying notifications", async () => {
    const response = await GET(request("site-b"));
    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildNotificationCenter).not.toHaveBeenCalled();
  });

  it("rejects a site that is not active in the organization", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(mocks.buildNotificationCenter).not.toHaveBeenCalled();
  });

  it("forwards authenticated role and exact tenant/site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ role: "MAINTENANCE_MANAGER" }));
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { id: true },
    });
    expect(mocks.buildNotificationCenter).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
    });
  });
});
