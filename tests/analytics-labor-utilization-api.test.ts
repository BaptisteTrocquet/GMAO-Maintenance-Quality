import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildLaborUtilizationDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/analytics/labor-utilization", () => ({
  buildLaborUtilizationDashboard: mocks.buildLaborUtilizationDashboard,
  LaborUtilizationError: class LaborUtilizationError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { GET } from "@/app/api/analytics/labor-utilization/route";

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
    `http://localhost/api/analytics/labor-utilization?organizationId=org-a&siteId=${siteId}&from=2026-07-01&to=2026-08-08`,
  );
}

describe("labor utilization analytics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ organization: { timezone: "Europe/Paris" } });
    mocks.buildLaborUtilizationDashboard.mockResolvedValue({ empty: true, laborHours: 0, assignees: [] });
  });

  it("passes validated tenant/site scope and site timezone to the analytics service", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { organization: { select: { timezone: true } } },
    });
    expect(mocks.buildLaborUtilizationDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-07-01",
      to: "2026-08-08",
      assetId: undefined,
    });
  });

  it("rejects a site outside explicit membership before analytics queries", async () => {
    const response = await GET(request("site-b"));

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildLaborUtilizationDashboard).not.toHaveBeenCalled();
  });

  it("requires maintenance read permission", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ role: "OPERATOR" }));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.buildLaborUtilizationDashboard).not.toHaveBeenCalled();
  });

  it("requires a complete local date range", async () => {
    const response = await GET(
      new Request("http://localhost/api/analytics/labor-utilization?organizationId=org-a&siteId=site-a&from=2026-07-01"),
    );

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
