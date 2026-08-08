import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  hasSiteAccess: vi.fn(),
  can: vi.fn(),
  siteFindFirst: vi.fn(),
  buildPmCompliance: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({ hasSiteAccess: mocks.hasSiteAccess }));
vi.mock("@/lib/permissions", () => ({ can: mocks.can }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/analytics/pm-compliance", () => {
  class PmComplianceError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    buildPmCompliance: mocks.buildPmCompliance,
    PmComplianceError,
  };
});

import { GET } from "@/app/api/analytics/pm-compliance/route";

const scope = {
  role: "MAINTENANCE_MANAGER",
};

function request(query: string) {
  return new Request(`http://localhost/api/analytics/pm-compliance?${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateRequest.mockResolvedValue({
    tenant: { scope },
    session: { user: { id: "user-a" } },
  });
  mocks.hasSiteAccess.mockReturnValue(true);
  mocks.can.mockReturnValue(true);
  mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
  mocks.buildPmCompliance.mockResolvedValue({
    due: 5,
    completedOnTime: 4,
    completedLate: 1,
    openOverdue: 0,
    missed: 1,
    complianceRate: 80,
    empty: false,
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-08-01T00:00:00.000Z",
    generatedAt: "2026-08-08T10:00:00.000Z",
  });
});

describe("GET /api/analytics/pm-compliance", () => {
  it("forwards tenant, site, date window and optional asset to the analytics service", async () => {
    const response = await GET(
      request(
        "organizationId=org-a&siteId=site-a&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z&assetId=asset-a",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.buildPmCompliance).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
      assetId: "asset-a",
    });
    expect(mocks.can).toHaveBeenCalledWith("MAINTENANCE_MANAGER", "maintenance:read");
  });

  it("rejects missing timestamps instead of coercing them to epoch dates", async () => {
    const response = await GET(request("organizationId=org-a&siteId=site-a"));

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.buildPmCompliance).not.toHaveBeenCalled();
  });

  it("rejects users without site access before analytics queries", async () => {
    mocks.hasSiteAccess.mockReturnValue(false);

    const response = await GET(
      request(
        "organizationId=org-a&siteId=site-b&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z",
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildPmCompliance).not.toHaveBeenCalled();
  });

  it("requires maintenance read permission", async () => {
    mocks.can.mockReturnValue(false);

    const response = await GET(
      request(
        "organizationId=org-a&siteId=site-a&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z",
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.buildPmCompliance).not.toHaveBeenCalled();
  });

  it("rejects a site outside the active organization scope", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(
      request(
        "organizationId=org-a&siteId=site-a&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z",
      ),
    );

    expect(response.status).toBe(404);
    expect(mocks.buildPmCompliance).not.toHaveBeenCalled();
  });
});
