import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildBacklogDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/analytics/backlog", () => ({
  buildBacklogDashboard: mocks.buildBacklogDashboard,
}));

import { GET } from "@/app/api/analytics/backlog/route";

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
  return new Request(`http://localhost/api/analytics/backlog?organizationId=org-a&siteId=${siteId}`);
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("backlog analytics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({
      id: "site-a",
      organization: { timezone: "Europe/Paris" },
    });
    mocks.buildBacklogDashboard.mockResolvedValue({ totalOpen: 0, empty: true });
  });

  it("passes tenant/site scope and the organization timezone to analytics", async () => {
    const response = await GET(request());

    await expectStatus(response, 200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: {
        id: true,
        organization: { select: { timezone: true } },
      },
    });
    expect(mocks.buildBacklogDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
    });
  });

  it("rejects a site outside explicit membership before querying analytics data", async () => {
    const response = await GET(request("site-b"));

    await expectStatus(response, 403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
  });

  it("requires all-sites access to resolve to an active site in the same organization", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ allSites: true, siteIds: [] }));
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(request("foreign-site"));

    await expectStatus(response, 404);
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
  });

  it("preserves authentication failures without touching analytics sources", async () => {
    mocks.authenticateRequest.mockResolvedValue({ error: new Response(null, { status: 401 }) });

    const response = await GET(request());

    await expectStatus(response, 401);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
  });
});
