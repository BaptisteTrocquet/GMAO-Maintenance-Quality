import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildBacklogDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: { site: { findFirst: mocks.siteFindFirst } },
}));

vi.mock("@/lib/analytics/backlog", () => ({
  buildBacklogDashboard: mocks.buildBacklogDashboard,
}));

import { GET } from "@/app/api/analytics/backlog/route";

function auth(overrides: Record<string, unknown> = {}) {
  return {
    session: { user: { id: "viewer-1" } },
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

function request(siteId = "site-a") {
  const params = new URLSearchParams({ organizationId: "org-a", siteId });
  return new Request(`http://localhost/api/analytics/backlog?${params.toString()}`);
}

describe("backlog analytics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.buildBacklogDashboard.mockResolvedValue({
      generatedAt: "2026-08-08T10:00:00.000Z",
      empty: true,
      totalOpen: 0,
      overdue: 0,
      unplanned: 0,
      urgent: 0,
      status: { REQUESTED: 0, APPROVED: 0, PLANNED: 0, IN_PROGRESS: 0, BLOCKED: 0 },
      aging: { DAYS_0_6: 0, DAYS_7_29: 0, DAYS_30_89: 0, DAYS_90_PLUS: 0 },
      oldest: [],
    });
  });

  it("passes only the authenticated organization/site scope to the KPI service", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(expect.any(Request), "org-a");
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { id: true },
    });
    expect(mocks.buildBacklogDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
    });
  });

  it("rejects a site outside the membership before analytics queries", async () => {
    const response = await GET(request("site-b"));

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
  });

  it("rejects a missing or inactive site inside the organization", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ allSites: true, siteIds: [] }));
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(request("site-missing"));

    expect(response.status).toBe(404);
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
  });

  it("preserves authentication failures", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      error: new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
  });
});
