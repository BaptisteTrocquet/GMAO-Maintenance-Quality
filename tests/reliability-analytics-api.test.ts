import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildReliabilityDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: { site: { findFirst: mocks.siteFindFirst } },
}));

vi.mock("@/lib/analytics/reliability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/reliability")>();
  return { ...actual, buildReliabilityDashboard: mocks.buildReliabilityDashboard };
});

import { GET } from "@/app/api/analytics/reliability/route";

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
    from: "2026-07-01",
    to: "2026-08-08",
    ...overrides,
  });
  return new Request(`http://localhost/api/analytics/reliability?${params.toString()}`);
}

describe("reliability analytics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ organization: { timezone: "Europe/Paris" } });
    mocks.buildReliabilityDashboard.mockResolvedValue({
      generatedAt: "2026-08-08T10:00:00.000Z",
      timezone: "Europe/Paris",
      range: { from: "2026-06-30T22:00:00.000Z", toExclusive: "2026-08-08T10:00:00.000Z" },
      assetId: null,
      mttr: { hours: null, sampleCount: 0 },
      mtbf: { hours: null, sampleCount: 0, assetCount: 0 },
      definitions: { mttr: "definition", mtbf: "definition" },
    });
  });

  it("uses the active site's timezone and authenticated tenant scope", async () => {
    const response = await GET(request({ assetId: "asset-a" }));

    expect(response.status).toBe(200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { organization: { select: { timezone: true } } },
    });
    expect(mocks.buildReliabilityDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      timeZone: "Europe/Paris",
      from: "2026-07-01",
      to: "2026-08-08",
      assetId: "asset-a",
    });
  });

  it("rejects a site outside the membership before querying analytics", async () => {
    const response = await GET(request({ siteId: "site-b" }));

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildReliabilityDashboard).not.toHaveBeenCalled();
  });

  it("requires maintenance:read even when the user can read work orders", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildReliabilityDashboard).not.toHaveBeenCalled();
  });

  it("rejects an inactive or cross-tenant site after membership validation", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN", { allSites: true, siteIds: [] }));
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(request({ siteId: "site-missing" }));

    expect(response.status).toBe(404);
    expect(mocks.buildReliabilityDashboard).not.toHaveBeenCalled();
  });

  it("rejects malformed local calendar dates before authentication", async () => {
    const response = await GET(request({ from: "08/01/2026" }));

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
