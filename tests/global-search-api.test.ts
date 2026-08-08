import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  searchGlobal: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/search/global-search", () => {
  class GlobalSearchError extends Error {}
  return { searchGlobal: mocks.searchGlobal, GlobalSearchError };
});

import { GET } from "@/app/api/search/route";

function auth(siteIds: string[] = ["site-a"]) {
  return {
    session: { user: { id: "user-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "VIEWER",
        active: true,
        allSites: false,
        siteIds,
      },
    },
  };
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("global search API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.searchGlobal.mockResolvedValue({ query: "pump", results: [], counts: {} });
  });

  it("passes only authenticated role and requested tenant scope to search", async () => {
    const response = await GET(
      new Request("http://localhost/api/search?organizationId=org-a&siteId=site-a&q=pump"),
    );

    await expectStatus(response, 200);
    expect(mocks.searchGlobal).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      role: "VIEWER",
      query: "pump",
    });
  });

  it("rejects a site outside the membership before any database search", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth(["site-b"]));

    const response = await GET(
      new Request("http://localhost/api/search?organizationId=org-a&siteId=site-a&q=pump"),
    );

    await expectStatus(response, 403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.searchGlobal).not.toHaveBeenCalled();
  });

  it("returns an opaque not-found for an inactive or foreign site", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/search?organizationId=org-a&siteId=site-a&q=pump"),
    );

    await expectStatus(response, 404);
    expect(mocks.searchGlobal).not.toHaveBeenCalled();
  });

  it("rejects short searches before authentication", async () => {
    const response = await GET(
      new Request("http://localhost/api/search?organizationId=org-a&siteId=site-a&q=x"),
    );

    await expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
