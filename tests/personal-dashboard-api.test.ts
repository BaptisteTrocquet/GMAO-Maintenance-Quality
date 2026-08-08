import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildPersonalDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/dashboard/personal", () => ({
  buildPersonalDashboard: mocks.buildPersonalDashboard,
}));

import { GET } from "@/app/api/dashboard/personal/route";

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
  return new Request(`http://localhost/api/dashboard/personal?organizationId=org-a&siteId=${siteId}`);
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("personal dashboard API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.buildPersonalDashboard.mockResolvedValue({ metrics: {}, workOrders: [], approvals: [] });
  });

  it("passes the authenticated user and role into the scoped dashboard service", async () => {
    const response = await GET(request());

    await expectStatus(response, 200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { id: true },
    });
    expect(mocks.buildPersonalDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      role: "MAINTENANCE_MANAGER",
    });
  });

  it("rejects a site outside explicit membership before querying site data", async () => {
    const response = await GET(request("site-b"));

    await expectStatus(response, 403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildPersonalDashboard).not.toHaveBeenCalled();
  });

  it("requires all-sites membership to resolve to a real active site in the organization", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ allSites: true, siteIds: [] }));
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(request("foreign-site"));

    await expectStatus(response, 404);
    expect(mocks.buildPersonalDashboard).not.toHaveBeenCalled();
  });

  it("preserves authentication failure without touching dashboard sources", async () => {
    mocks.authenticateRequest.mockResolvedValue({ error: new Response(null, { status: 401 }) });

    const response = await GET(request());

    await expectStatus(response, 401);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildPersonalDashboard).not.toHaveBeenCalled();
  });
});
