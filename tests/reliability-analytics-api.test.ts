import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildReliabilityDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/analytics/reliability", () => ({
  buildReliabilityDashboard: mocks.buildReliabilityDashboard,
}));

import { GET } from "@/app/api/analytics/reliability/route";

function auth(overrides: Record<string, unknown> = {}) {
  return {
    session: { user: { id: "user-a" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "MAINTENANCE_MANAGER" as const,
        allSites: false,
        siteIds: ["site-a"],
        active: true,
        ...overrides,
      },
    },
  };
}

function request(siteId = "site-a") {
  return new Request(
    `http://localhost/api/analytics/reliability?organizationId=org-a&siteId=${siteId}`,
  );
}

describe("reliability analytics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.buildReliabilityDashboard.mockResolvedValue({
      mttr: { hours: null, sampleCount: 0 },
      mtbfProxy: { hours: null, sampleCount: 0, assetCount: 0 },
    });
  });

  it("passes only the validated tenant/site scope to the reliability service", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { id: true },
    });
    expect(mocks.buildReliabilityDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
    });
  });

  it("rejects a site outside explicit membership before querying the database", async () => {
    const response = await GET(request("site-b"));

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildReliabilityDashboard).not.toHaveBeenCalled();
  });

  it("requires work-read permission", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ role: "VIEWER" }));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
  });

  it("returns 404 when an all-sites membership references a site outside the organization", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ allSites: true, siteIds: [] }));
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(request("foreign-site"));

    expect(response.status).toBe(404);
    expect(mocks.buildReliabilityDashboard).not.toHaveBeenCalled();
  });

  it("preserves authentication errors", async () => {
    mocks.authenticateRequest.mockResolvedValue({ error: new Response(null, { status: 401 }) });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
  });

  it("requires organizationId and siteId", async () => {
    const response = await GET(
      new Request("http://localhost/api/analytics/reliability?organizationId=org-a"),
    );

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
