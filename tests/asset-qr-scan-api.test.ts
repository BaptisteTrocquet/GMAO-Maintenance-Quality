import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  return {
    AccessDeniedError,
    authenticateRequest: vi.fn(),
    assertSitePermission: vi.fn(),
    siteFindFirst: vi.fn(),
    assetFindFirst: vi.fn(),
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    asset: { findFirst: mocks.assetFindFirst },
  },
}));

import { POST } from "@/app/api/assets/scan/route";

function auth() {
  return {
    session: { user: { id: "tech-a" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "TECHNICIAN",
        allSites: false,
        siteIds: ["site-a"],
        active: true,
      },
    },
  };
}

function scanRequest(payload: string, overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/assets/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      payload,
      ...overrides,
    }),
  });
}

async function post(request: Request) {
  const response = await POST(request);
  if (!response) throw new Error("Expected QR scan API response");
  return response;
}

describe("asset QR scan API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-1", code: "A-001", name: "Demo Asset" });
  });

  it("resolves a valid asset route only after asset read permission and site validation", async () => {
    const response = await post(scanRequest("/assets/asset-1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a" }),
      "site-a",
      "asset:read",
    );
    expect(mocks.siteFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "site-a", organizationId: "org-a", active: true } }),
    );
    expect(mocks.assetFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "asset-1", siteId: "site-a", archivedAt: null },
      }),
    );
    expect(body.data.href).toBe("/assets/asset-1");
  });

  it("accepts only same-origin absolute QR URLs", async () => {
    const response = await post(scanRequest("https://other.example/assets/asset-1"));

    expect(response.status).toBe(400);
    expect(mocks.assetFindFirst).not.toHaveBeenCalled();
  });

  it("does not query assets when site permission is denied", async () => {
    mocks.assertSitePermission.mockImplementation(() => {
      throw new mocks.AccessDeniedError("Missing permission");
    });

    const response = await post(scanRequest("/assets/asset-1"));

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.assetFindFirst).not.toHaveBeenCalled();
  });

  it("returns not found when the QR asset is outside the selected site", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    const response = await post(scanRequest("/assets/asset-1"));

    expect(response.status).toBe(404);
  });

  it("rejects malformed input before authentication", async () => {
    const response = await post(scanRequest("", { organizationId: "" }));

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
