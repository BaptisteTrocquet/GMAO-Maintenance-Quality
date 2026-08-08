import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  hasSiteAccess: vi.fn(),
  can: vi.fn(),
  siteFindFirst: vi.fn(),
  buildDowntimeDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({ hasSiteAccess: mocks.hasSiteAccess }));
vi.mock("@/lib/permissions", () => ({ can: mocks.can }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/analytics/downtime", () => {
  class DowntimeAnalyticsError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    buildDowntimeDashboard: mocks.buildDowntimeDashboard,
    DowntimeAnalyticsError,
  };
});

import { GET } from "@/app/api/analytics/downtime/route";

const scope = { role: "MAINTENANCE_MANAGER" };

function request(query: string) {
  return new Request(`http://localhost/api/analytics/downtime?${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateRequest.mockResolvedValue({ tenant: { scope }, session: { user: { id: "user-a" } } });
  mocks.hasSiteAccess.mockReturnValue(true);
  mocks.can.mockReturnValue(true);
  mocks.siteFindFirst.mockResolvedValue({ organization: { timezone: "Europe/Paris" } });
  mocks.buildDowntimeDashboard.mockResolvedValue({
    generatedAt: "2026-08-08T10:00:00.000Z",
    timezone: "Europe/Paris",
    range: { from: "2026-06-30T22:00:00.000Z", toExclusive: "2026-07-31T22:00:00.000Z" },
    assetId: null,
    empty: true,
    totalMinutes: 0,
    totalHours: 0,
    eventCount: 0,
    averageMinutesPerEvent: null,
    trend: [],
    topAssets: [],
    definition: "Synthetic definition",
  });
});

describe("GET /api/analytics/downtime", () => {
  it("forwards tenant/site timezone, local calendar dates and optional asset", async () => {
    const response = await GET(request(
      "organizationId=org-a&siteId=site-a&from=2026-07-01&to=2026-07-31&assetId=asset-a",
    ));
    expect(response.status).toBe(200);
    expect(mocks.buildDowntimeDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-07-01",
      to: "2026-07-31",
      assetId: "asset-a",
    });
  });

  it("rejects timestamp-shaped or missing dates before authentication", async () => {
    const timestamp = await GET(request(
      "organizationId=org-a&siteId=site-a&from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-31",
    ));
    expect(timestamp.status).toBe(400);
    const missing = await GET(request("organizationId=org-a&siteId=site-a"));
    expect(missing.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });

  it("rejects users without site access", async () => {
    mocks.hasSiteAccess.mockReturnValue(false);
    const response = await GET(request("organizationId=org-a&siteId=site-b&from=2026-07-01&to=2026-07-31"));
    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildDowntimeDashboard).not.toHaveBeenCalled();
  });

  it("requires maintenance read permission", async () => {
    mocks.can.mockReturnValue(false);
    const response = await GET(request("organizationId=org-a&siteId=site-a&from=2026-07-01&to=2026-07-31"));
    expect(response.status).toBe(403);
    expect(mocks.buildDowntimeDashboard).not.toHaveBeenCalled();
  });

  it("rejects inactive or cross-tenant sites", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);
    const response = await GET(request("organizationId=org-a&siteId=site-a&from=2026-07-01&to=2026-07-31"));
    expect(response.status).toBe(404);
    expect(mocks.buildDowntimeDashboard).not.toHaveBeenCalled();
  });
});
