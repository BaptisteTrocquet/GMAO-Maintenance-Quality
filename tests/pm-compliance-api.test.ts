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
  mocks.siteFindFirst.mockResolvedValue({
    id: "site-a",
    organization: { timezone: "Europe/Paris" },
  });
  mocks.buildPmCompliance.mockResolvedValue({
    due: 5,
    completedOnTime: 4,
    completedLate: 1,
    openOverdue: 0,
    missed: 1,
    complianceRate: 80,
    empty: false,
    from: "2026-03-28T23:00:00.000Z",
    to: "2026-03-29T22:00:00.000Z",
    generatedAt: "2026-03-29T12:00:00.000Z",
  });
});

describe("GET /api/analytics/pm-compliance", () => {
  it("converts site-calendar dates to a DST-safe half-open UTC range", async () => {
    const response = await GET(
      request(
        "organizationId=org-a&siteId=site-a&from=2026-03-29&to=2026-03-29&assetId=asset-a",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { id: true, organization: { select: { timezone: true } } },
    });
    expect(mocks.buildPmCompliance).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      from: new Date("2026-03-28T23:00:00.000Z"),
      to: new Date("2026-03-29T22:00:00.000Z"),
      assetId: "asset-a",
    });
    expect(mocks.can).toHaveBeenCalledWith("MAINTENANCE_MANAGER", "maintenance:read");

    const body = await response.json();
    expect(body.data.reporting).toEqual({
      fromDate: "2026-03-29",
      throughDate: "2026-03-29",
      timeZone: "Europe/Paris",
    });
  });

  it("rejects missing calendar dates instead of coercing them to timestamps", async () => {
    const response = await GET(request("organizationId=org-a&siteId=site-a"));

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.buildPmCompliance).not.toHaveBeenCalled();
  });

  it("rejects invalid or inverted calendar ranges", async () => {
    const invalid = await GET(
      request("organizationId=org-a&siteId=site-a&from=2026-02-30&to=2026-03-01"),
    );
    expect(invalid.status).toBe(400);
    expect(mocks.buildPmCompliance).not.toHaveBeenCalled();

    const inverted = await GET(
      request("organizationId=org-a&siteId=site-a&from=2026-03-30&to=2026-03-29"),
    );
    expect(inverted.status).toBe(400);
    expect(mocks.buildPmCompliance).not.toHaveBeenCalled();
  });

  it("rejects users without site access before analytics queries", async () => {
    mocks.hasSiteAccess.mockReturnValue(false);

    const response = await GET(
      request("organizationId=org-a&siteId=site-b&from=2026-03-01&to=2026-03-31"),
    );

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildPmCompliance).not.toHaveBeenCalled();
  });

  it("requires maintenance read permission", async () => {
    mocks.can.mockReturnValue(false);

    const response = await GET(
      request("organizationId=org-a&siteId=site-a&from=2026-03-01&to=2026-03-31"),
    );

    expect(response.status).toBe(403);
    expect(mocks.buildPmCompliance).not.toHaveBeenCalled();
  });

  it("rejects a site outside the active organization scope", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(
      request("organizationId=org-a&siteId=site-a&from=2026-03-01&to=2026-03-31"),
    );

    expect(response.status).toBe(404);
    expect(mocks.buildPmCompliance).not.toHaveBeenCalled();
  });
});
