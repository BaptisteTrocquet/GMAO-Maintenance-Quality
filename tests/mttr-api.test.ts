import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  hasSiteAccess: vi.fn(),
  can: vi.fn(),
  siteFindFirst: vi.fn(),
  buildMttr: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({ hasSiteAccess: mocks.hasSiteAccess }));
vi.mock("@/lib/permissions", () => ({ can: mocks.can }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/analytics/mttr", () => {
  class MttrError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return { buildMttr: mocks.buildMttr, MttrError };
});

import { GET } from "@/app/api/analytics/mttr/route";

function request(query: string) {
  return new Request(`http://localhost/api/analytics/mttr?${query}`);
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
    organization: { timezone: "Europe/Paris" },
  });
  mocks.buildMttr.mockResolvedValue({
    completedCorrective: 4,
    validRepairs: 4,
    incompleteRepairs: 0,
    totalRepairMinutes: 600,
    mttrMinutes: 150,
    mttrHours: 2.5,
    empty: false,
    insufficientData: false,
    from: "2026-06-30T22:00:00.000Z",
    to: "2026-07-31T22:00:00.000Z",
    generatedAt: "2026-08-08T10:00:00.000Z",
  });
});

describe("GET /api/analytics/mttr", () => {
  it("resolves local calendar dates in the organization timezone before calling MTTR", async () => {
    const response = await GET(
      request("organizationId=org-a&siteId=site-a&from=2026-07-01&to=2026-07-31&assetId=asset-a"),
    );

    expect(response.status).toBe(200);
    expect(mocks.buildMttr).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      from: new Date("2026-06-30T22:00:00.000Z"),
      to: new Date("2026-07-31T22:00:00.000Z"),
      assetId: "asset-a",
    });
  });

  it("uses DST-aware 23-hour local-day boundaries", async () => {
    const response = await GET(
      request("organizationId=org-a&siteId=site-a&from=2026-03-29&to=2026-03-29"),
    );

    expect(response.status).toBe(200);
    expect(mocks.buildMttr).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      from: new Date("2026-03-28T23:00:00.000Z"),
      to: new Date("2026-03-29T22:00:00.000Z"),
      assetId: undefined,
    });
  });

  it("rejects missing or malformed local calendar dates", async () => {
    expect((await GET(request("organizationId=org-a&siteId=site-a"))).status).toBe(400);
    expect(
      (await GET(request("organizationId=org-a&siteId=site-a&from=2026-07-01T00:00:00Z&to=2026-07-31"))).status,
    ).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });

  it("rejects users without site access or maintenance permission", async () => {
    mocks.hasSiteAccess.mockReturnValue(false);
    expect(
      (await GET(request("organizationId=org-a&siteId=site-b&from=2026-07-01&to=2026-07-31"))).status,
    ).toBe(403);
    expect(mocks.buildMttr).not.toHaveBeenCalled();

    mocks.hasSiteAccess.mockReturnValue(true);
    mocks.can.mockReturnValue(false);
    expect(
      (await GET(request("organizationId=org-a&siteId=site-a&from=2026-07-01&to=2026-07-31"))).status,
    ).toBe(403);
  });

  it("rejects an inactive or cross-organization site before the KPI query", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);
    const response = await GET(
      request("organizationId=org-a&siteId=site-a&from=2026-07-01&to=2026-07-31"),
    );
    expect(response.status).toBe(404);
    expect(mocks.buildMttr).not.toHaveBeenCalled();
  });
});
