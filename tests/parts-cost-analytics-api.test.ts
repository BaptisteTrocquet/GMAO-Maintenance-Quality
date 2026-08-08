import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildPartsCostDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/analytics/parts-cost", () => {
  class PartsCostAnalyticsError extends Error {
    constructor(public readonly code: "ASSET_NOT_FOUND" | "RANGE_TOO_LARGE", message: string) {
      super(message);
    }
  }
  return {
    buildPartsCostDashboard: mocks.buildPartsCostDashboard,
    PartsCostAnalyticsError,
  };
});

import { GET } from "@/app/api/analytics/parts-cost/route";

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

function request(extra = "") {
  return new Request(
    `http://localhost/api/analytics/parts-cost?organizationId=org-a&siteId=site-a&from=2026-06-01&to=2026-07-31${extra}`,
  );
}

describe("parts cost analytics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ organization: { timezone: "Europe/Paris" } });
    mocks.buildPartsCostDashboard.mockResolvedValue({ empty: true, trend: [], topParts: [] });
  });

  it("forwards only the validated tenant/site timezone and optional asset filter", async () => {
    const response = await GET(request("&assetId=asset-a"));

    expect(response.status).toBe(200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { organization: { select: { timezone: true } } },
    });
    expect(mocks.buildPartsCostDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-06-01",
      to: "2026-07-31",
      assetId: "asset-a",
    });
  });

  it("rejects a site outside explicit membership before database access", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/analytics/parts-cost?organizationId=org-a&siteId=site-b&from=2026-06-01&to=2026-07-31",
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildPartsCostDashboard).not.toHaveBeenCalled();
  });

  it("requires inventory-read permission", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ role: "QUALITY_MANAGER" }));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildPartsCostDashboard).not.toHaveBeenCalled();
  });

  it("returns 404 when an all-sites membership names a site outside the organization", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ allSites: true, siteIds: [] }));
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(
      new Request(
        "http://localhost/api/analytics/parts-cost?organizationId=org-a&siteId=foreign-site&from=2026-06-01&to=2026-07-31",
      ),
    );

    expect(response.status).toBe(404);
    expect(mocks.buildPartsCostDashboard).not.toHaveBeenCalled();
  });

  it("requires complete local-date query parameters before authentication", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/analytics/parts-cost?organizationId=org-a&siteId=site-a&from=2026-06-01",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });

  it("preserves authentication failures", async () => {
    mocks.authenticateRequest.mockResolvedValue({ error: new Response(null, { status: 401 }) });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
  });
});
