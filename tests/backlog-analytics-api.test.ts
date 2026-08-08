import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  hasSiteAccess: vi.fn(),
  can: vi.fn(),
  siteFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  getBacklogAnalytics: vi.fn(),
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
vi.mock("@/lib/analytics/backlog", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analytics/backlog")>(
    "@/lib/analytics/backlog",
  );
  return {
    ...actual,
    getBacklogAnalytics: mocks.getBacklogAnalytics,
    exportBacklogCsv: mocks.exportBacklogCsv,
  };
});

import { GET } from "@/app/api/analytics/backlog/route";

const auth = {
  session: { user: { id: "user-1" } },
  tenant: { scope: { role: "MAINTENANCE_MANAGER", siteIds: ["site-a"], allSites: false } },
};

describe("backlog analytics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.hasSiteAccess.mockReturnValue(true);
    mocks.can.mockReturnValue(true);
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-1" });
    mocks.getBacklogAnalytics.mockResolvedValue({ metrics: { total: 3 } });
    mocks.exportBacklogCsv.mockResolvedValue({
      csv: "number\r\nWO-0001\r\n",
      rowCount: 1,
      truncated: false,
      limit: 5000,
    });
  });

  it("requires organization and site scope", async () => {
    const response = await GET(new Request("http://localhost/api/analytics/backlog"));
    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });

  it("enforces both site access and work read permission", async () => {
    mocks.can.mockReturnValue(false);

    const response = await GET(
      new Request("http://localhost/api/analytics/backlog?organizationId=org-a&siteId=site-a"),
    );

    expect(response.status).toBe(403);
    expect(mocks.getBacklogAnalytics).not.toHaveBeenCalled();
  });

  it("rejects an asset outside the authorized site before analytics query", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    const response = await GET(
      new Request(
        "http://localhost/api/analytics/backlog?organizationId=org-a&siteId=site-a&assetId=asset-other",
      ),
    );

    expect(response.status).toBe(404);
    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: {
        id: "asset-other",
        siteId: "site-a",
        site: { organizationId: "org-a", active: true },
      },
      select: { id: true },
    });
    expect(mocks.getBacklogAnalytics).not.toHaveBeenCalled();
  });

  it("forwards tenant scope and requested-date filters to the JSON analytics service", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/analytics/backlog?organizationId=org-a&siteId=site-a&assetId=asset-1&fromDate=2026-08-01&toDate=2026-08-08",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.getBacklogAnalytics).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      assetId: "asset-1",
      fromDate: "2026-08-01",
      toDate: "2026-08-08",
    });
  });

  it("returns a bounded CSV download with export metadata", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/analytics/backlog?organizationId=org-a&siteId=site-a&format=csv",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("backlog-analytics.csv");
    expect(response.headers.get("x-export-row-count")).toBe("1");
    expect(response.headers.get("x-export-truncated")).toBe("false");
    expect(await response.text()).toContain("WO-0001");
  });
});
