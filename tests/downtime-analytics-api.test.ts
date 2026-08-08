import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildDowntimeDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: { site: { findFirst: mocks.siteFindFirst } },
}));

vi.mock("@/lib/analytics/downtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/downtime")>();
  return { ...actual, buildDowntimeDashboard: mocks.buildDowntimeDashboard };
});

import { GET } from "@/app/api/analytics/downtime/route";

function auth(role = "TECHNICIAN", overrides: Record<string, unknown> = {}) {
  return {
    session: { user: { id: "user-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role,
        allSites: false,
        siteIds: ["site-a"],
        active: true,
        ...overrides,
      },
    },
  };
}

function request(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    organizationId: "org-a",
    siteId: "site-a",
    from: "2026-01-01",
    to: "2026-03-31",
    ...overrides,
  });
  return new Request(`http://localhost/api/analytics/downtime?${params.toString()}`);
}

describe("downtime analytics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ organization: { timezone: "Europe/Paris" } });
    mocks.buildDowntimeDashboard.mockResolvedValue({ empty: true });
  });

  it("forwards tenant/site timezone and optional asset filter", async () => {
    const response = await GET(request({ assetId: "asset-a" }));

    expect(response.status).toBe(200);
    expect(mocks.buildDowntimeDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-01-01",
      to: "2026-03-31",
      assetId: "asset-a",
    });
  });

  it("rejects sites outside the membership before database analytics", async () => {
    const response = await GET(request({ siteId: "site-b" }));

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildDowntimeDashboard).not.toHaveBeenCalled();
  });

  it("requires maintenance analytics permission", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.buildDowntimeDashboard).not.toHaveBeenCalled();
  });

  it("rejects an inactive or cross-tenant site", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN", { allSites: true, siteIds: [] }));
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(request({ siteId: "site-missing" }));

    expect(response.status).toBe(404);
    expect(mocks.buildDowntimeDashboard).not.toHaveBeenCalled();
  });

  it("rejects malformed date inputs before authentication", async () => {
    const response = await GET(request({ from: "2026/01/01" }));

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
