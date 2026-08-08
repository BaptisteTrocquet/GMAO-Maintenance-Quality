import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildBacklogDashboard: vi.fn(),
  exportBacklogCsv: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/analytics/backlog", () => ({
  buildBacklogDashboard: mocks.buildBacklogDashboard,
  exportBacklogCsv: mocks.exportBacklogCsv,
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

function request(siteId = "site-a", format?: string) {
  const params = new URLSearchParams({ organizationId: "org-a", siteId });
  if (format) params.set("format", format);
  return new Request(`http://localhost/api/analytics/backlog?${params.toString()}`);
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
      code: "SITE-A",
      organization: { timezone: "Europe/Paris" },
    });
    mocks.buildBacklogDashboard.mockResolvedValue({ empty: true, totalOpen: 0, oldest: [] });
    mocks.exportBacklogCsv.mockResolvedValue({
      csv: "number,title\r\nWO-1,Synthetic work\r\n",
      rowCount: 1,
      truncated: false,
      limit: 5000,
    });
  });

  it("forwards validated organization/site scope and organization timezone", async () => {
    const response = await GET(request());

    await expectStatus(response, 200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { id: true, code: true, organization: { select: { timezone: true } } },
    });
    expect(mocks.buildBacklogDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
    });
    expect(mocks.exportBacklogCsv).not.toHaveBeenCalled();
  });

  it("exports CSV only after the same tenant/site authorization", async () => {
    const response = await GET(request("site-a", "csv"));

    await expectStatus(response, 200);
    expect(response?.headers.get("content-type")).toContain("text/csv");
    expect(response?.headers.get("content-disposition")).toContain("backlog-SITE-A-");
    expect(response?.headers.get("x-opengmao-row-count")).toBe("1");
    expect(response?.headers.get("x-opengmao-export-limit")).toBe("5000");
    expect(response?.headers.get("x-opengmao-truncated")).toBe("false");
    expect(await response?.text()).toContain("WO-1,Synthetic work");
    expect(mocks.exportBacklogCsv).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
    });
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
  });

  it("rejects unsupported export formats before reading analytics sources", async () => {
    const response = await GET(request("site-a", "xlsx"));

    await expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.exportBacklogCsv).not.toHaveBeenCalled();
  });

  it("rejects a site outside explicit membership before querying analytics", async () => {
    const response = await GET(request("site-b", "csv"));

    await expectStatus(response, 403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
    expect(mocks.exportBacklogCsv).not.toHaveBeenCalled();
  });

  it("requires all-sites scope to resolve to an active site in the organization", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ allSites: true, siteIds: [] }));
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(request("foreign-site", "csv"));

    await expectStatus(response, 404);
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
    expect(mocks.exportBacklogCsv).not.toHaveBeenCalled();
  });

  it("preserves authentication failures without reading analytics sources", async () => {
    mocks.authenticateRequest.mockResolvedValue({ error: new Response(null, { status: 401 }) });

    const response = await GET(request("site-a", "csv"));

    await expectStatus(response, 401);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildBacklogDashboard).not.toHaveBeenCalled();
    expect(mocks.exportBacklogCsv).not.toHaveBeenCalled();
  });

  it("requires organizationId and siteId", async () => {
    const response = await GET(new Request("http://localhost/api/analytics/backlog?organizationId=org-a"));

    await expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
