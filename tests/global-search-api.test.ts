import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  searchGlobal: vi.fn(),
  siteFindFirst: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
  },
}));
vi.mock("@/lib/search/global-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search/global-search")>();
  return { ...actual, searchGlobal: mocks.searchGlobal };
});

import { GET } from "@/app/api/search/route";

function request(query = "pump", siteId = "site-a") {
  const params = new URLSearchParams({ organizationId: "org-a", siteId, q: query });
  return new Request(`http://localhost/api/search?${params.toString()}`);
}

function requireResponse(response: Response | undefined) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  return response;
}

function auth(overrides: Record<string, unknown> = {}) {
  return {
    session: { user: { id: "user-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "VIEWER",
        allSites: false,
        siteIds: ["site-a"],
        active: true,
        ...overrides,
      },
    },
  };
}

describe("global search API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.searchGlobal.mockResolvedValue([
      {
        kind: "ASSET",
        id: "asset-1",
        label: "PUMP-01 · Synthetic pump",
        description: "Asset",
        meta: "ACTIVE · HIGH",
        href: "/assets/asset-1",
        score: 0,
      },
    ]);
  });

  it("rejects short queries before authentication or database search", async () => {
    const response = requireResponse(await GET(request("x")));

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.searchGlobal).not.toHaveBeenCalled();
  });

  it("passes the authenticated role and selected tenant/site scope to search", async () => {
    const response = requireResponse(await GET(request()));

    expect(response.status).toBe(200);
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(expect.any(Request), "org-a");
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { id: true },
    });
    expect(mocks.searchGlobal).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      role: "VIEWER",
      query: "pump",
    });
    await expect(response.json()).resolves.toEqual({
      data: {
        query: "pump",
        results: [expect.objectContaining({ kind: "ASSET", id: "asset-1" })],
      },
    });
  });

  it("rejects a site outside the membership before any category query", async () => {
    const response = requireResponse(await GET(request("pump", "site-b")));

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.searchGlobal).not.toHaveBeenCalled();
  });

  it("validates all-sites membership against a real active site in the organization", async () => {
    mocks.authenticateRequest.mockResolvedValue(
      auth({ role: "QUALITY_MANAGER", allSites: true, siteIds: [] }),
    );

    const response = requireResponse(await GET(request("audit", "site-b")));

    expect(response.status).toBe(200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-b", organizationId: "org-a", active: true },
      select: { id: true },
    });
    expect(mocks.searchGlobal).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-b",
      role: "QUALITY_MANAGER",
      query: "audit",
    });
  });

  it("rejects an arbitrary or cross-organization site even for all-sites membership", async () => {
    mocks.authenticateRequest.mockResolvedValue(
      auth({ role: "QUALITY_MANAGER", allSites: true, siteIds: [] }),
    );
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = requireResponse(await GET(request("audit", "foreign-site")));

    expect(response.status).toBe(404);
    expect(mocks.searchGlobal).not.toHaveBeenCalled();
  });

  it("normalizes whitespace before invoking the search engine", async () => {
    const response = requireResponse(await GET(request("  pump   seal  ")));

    expect(response.status).toBe(200);
    expect(mocks.searchGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ query: "pump seal" }),
    );
  });

  it("preserves an authentication error without invoking search", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      error: new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    });

    const response = requireResponse(await GET(request()));

    expect(response.status).toBe(401);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.searchGlobal).not.toHaveBeenCalled();
  });
});
