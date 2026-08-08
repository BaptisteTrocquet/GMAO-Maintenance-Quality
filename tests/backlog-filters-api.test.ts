import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  hasSiteAccess: vi.fn(),
  can: vi.fn(),
  siteFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  buildBacklogDashboard: vi.fn(),
  exportBacklogCsv: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({ hasSiteAccess: mocks.hasSiteAccess }));
vi.mock("@/lib/permissions", () => ({ can: mocks.can }));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    asset: { findFirst: mocks.assetFindFirst },
  },
}));
vi.mock("@/lib/analytics/backlog", () => ({
  buildBacklogDashboard: mocks.buildBacklogDashboard,
  exportBacklogCsv: mocks.exportBacklogCsv,
}));

import { GET } from "@/app/api/analytics/backlog/route";

function request(extra = "") {
  return new Request(
    `http://localhost/api/analytics/backlog?organizationId=org-a&siteId=site-a${extra}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateRequest.mockResolvedValue({
    tenant: { scope: { role: "MAINTENANCE_MANAGER" } },
    session: { user: { id: "user-a" } },
  });
  mocks.hasSiteAccess.mockReturnValue(true);
  mocks.can.mockReturnValue(true);
  mocks.siteFindFirst.mockResolvedValue({
    id: "site-a",
    code: "SITE-A",
    organization: { timezone: "Europe/Paris" },
  });
  mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
  mocks.buildBacklogDashboard.mockResolvedValue({ empty: true, totalOpen: 0, oldest: [] });
  mocks.exportBacklogCsv.mockResolvedValue({
    csv: "number\r\n",
    rowCount: 0,
    truncated: false,
    limit: 5000,
  });
});

describe("backlog filter API", () => {
  it("validates asset scope and forwards site-calendar filters to dashboard analytics", async () => {
    const response = await GET(
      request("&assetId=asset-a&from=2026-03-29&to=2026-03-29"),
    );

    expect(response.status).toBe(200);
    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: {
        id: "asset-a",
        siteId: "site-a",
        site: { organizationId: "org-a", active: true },
      },
      select: { id: true },
    });
    expect(mocks.buildBacklogDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      assetId: "asset-a",
      from: "2026-03-29",
      to: "2026-03-29",
    });
  });

  it("forwards the exact same filters to CSV export", async () => {
    const response = await GET(
      request("&format=csv&assetId=asset-a&from=2026-03-29&to=2026-03-29"),
    );

    expect(response.status).toBe(200);
    expect(mocks.exportBacklogCsv).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      assetId: "asset-a",
      from: "2026-03-29",
      to: "2026-03-29",
      timeZone: "Europe/Paris",
    });
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
  });

  it("rejects invalid local dates before asset or analytics data access", async () => {
    const response = await GET(
      request("&assetId=asset-a&from=2026-02-30&to=2026-03-01"),
    );

    expect(response.status).toBe(400);
    expect(mocks.assetFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
    expect(mocks.exportBacklogCsv).not.toHaveBeenCalled();
  });

  it("rejects cross-site asset filters instead of returning an ambiguous empty KPI set", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    const response = await GET(request("&assetId=asset-other"));

    expect(response.status).toBe(404);
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
    expect(mocks.exportBacklogCsv).not.toHaveBeenCalled();
  });
});
