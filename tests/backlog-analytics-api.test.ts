import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  getBacklogAnalytics: vi.fn(),
  exportBacklogCsv: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    asset: { findFirst: mocks.assetFindFirst },
  },
}));
vi.mock("@/lib/analytics/backlog", () => ({
  getBacklogAnalytics: mocks.getBacklogAnalytics,
  exportBacklogCsv: mocks.exportBacklogCsv,
}));

import { GET } from "@/app/api/analytics/backlog/route";
import { AnalyticsDateRangeError } from "@/lib/analytics/date-range";

function auth(overrides: Record<string, unknown> = {}) {
  return {
    session: { user: { id: "user-a" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "VIEWER" as const,
        allSites: false,
        siteIds: ["site-a"],
        active: true,
        ...overrides,
      },
    },
  };
}

function request(input: {
  siteId?: string;
  assetId?: string;
  from?: string;
  to?: string;
  format?: "json" | "csv";
} = {}) {
  const params = new URLSearchParams({
    organizationId: "org-a",
    siteId: input.siteId ?? "site-a",
  });
  if (input.assetId) params.set("assetId", input.assetId);
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  if (input.format) params.set("format", input.format);
  return new Request(`http://localhost/api/analytics/backlog?${params.toString()}`);
}

describe("backlog analytics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({
      id: "site-a",
      code: "SITE-A",
      name: "Synthetic site",
      organization: { timezone: "Europe/Paris" },
    });
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-a" });
    mocks.getBacklogAnalytics.mockResolvedValue({ metrics: { total: 0 } });
    mocks.exportBacklogCsv.mockResolvedValue({
      csv: "number,title\r\nWO-1,Synthetic\r\n",
      rowCount: 1,
      truncated: false,
      limit: 5000,
    });
  });

  it("enforces work-read access and validates the active site in the organization", async () => {
    const response = await GET(request({ from: "2026-03-29", to: "2026-03-30" }));

    expect(response.status).toBe(200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: {
        id: true,
        code: true,
        name: true,
        organization: { select: { timezone: true } },
      },
    });
    expect(mocks.getBacklogAnalytics).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      assetId: null,
      fromDate: "2026-03-29",
      toDate: "2026-03-30",
    });
  });

  it("rejects a site outside explicit membership before querying site data", async () => {
    const response = await GET(request({ siteId: "site-b" }));

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.getBacklogAnalytics).not.toHaveBeenCalled();
  });

  it("still validates an all-sites request against a real active site in the organization", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ allSites: true, siteIds: [] }));
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(request({ siteId: "foreign-site" }));

    expect(response.status).toBe(404);
    expect(mocks.getBacklogAnalytics).not.toHaveBeenCalled();
  });

  it("rejects a cross-site asset before calculating any KPI", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    const response = await GET(request({ assetId: "asset-foreign" }));

    expect(response.status).toBe(404);
    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: { id: "asset-foreign", siteId: "site-a" },
      select: { id: true },
    });
    expect(mocks.getBacklogAnalytics).not.toHaveBeenCalled();
  });

  it("returns explicit date-range validation errors", async () => {
    mocks.getBacklogAnalytics.mockRejectedValue(
      new AnalyticsDateRangeError("INVALID_RANGE", "from must be on or before to"),
    );

    const response = await GET(request({ from: "2026-04-02", to: "2026-04-01" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_RANGE", message: "from must be on or before to" },
    });
  });

  it("exports CSV from the exact same tenant/site/timezone/filter scope", async () => {
    const response = await GET(
      request({ assetId: "asset-a", from: "2026-03-01", to: "2026-03-31", format: "csv" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("x-opengmao-row-count")).toBe("1");
    expect(response.headers.get("x-opengmao-export-limit")).toBe("5000");
    expect(response.headers.get("x-opengmao-truncated")).toBe("false");
    expect(response.headers.get("content-disposition")).toContain("backlog-SITE-A-");
    expect(mocks.exportBacklogCsv).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      assetId: "asset-a",
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    expect(await response.text()).toBe("number,title\r\nWO-1,Synthetic\r\n");
  });
});
