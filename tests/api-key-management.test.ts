import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertSitePermission: vi.fn(),
  siteFindFirst: vi.fn(),
  createApiKey: vi.fn(),
  isApiKeyRecord: vi.fn(),
  listApiKeys: vi.fn(),
  tokenUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticate }));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: class AccessDeniedError extends Error {},
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    publicMaintenanceRequestToken: { updateMany: mocks.tokenUpdateMany },
    auditLog: { create: mocks.auditCreate },
  },
}));
vi.mock("@/lib/integrations/api-keys", () => ({
  createApiKey: mocks.createApiKey,
  isApiKeyRecord: mocks.isApiKeyRecord,
  listApiKeys: mocks.listApiKeys,
}));

import { DELETE, GET, POST } from "@/app/api/api-keys/route";

const scope = { organizationId: "org-a", role: "OWNER", allSites: true, siteIds: ["site-a"] };

function authResult() {
  return {
    session: { user: { id: "manager-1" } },
    tenant: { scope },
  };
}

describe("API key management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue(authResult());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.createApiKey.mockResolvedValue({
      apiKey: "gmao_sk_secret-once",
      id: "key-record-1",
      organizationId: "org-a",
      siteId: "site-a",
      name: "Server integration",
      scopes: ["asset:read", "kpi:read"],
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      createdAt: new Date("2026-08-07T20:00:00.000Z"),
    });
    mocks.isApiKeyRecord.mockResolvedValue(true);
    mocks.tokenUpdateMany.mockResolvedValue({ count: 1 });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.listApiKeys.mockResolvedValue([]);
  });

  it("requires site management and every delegated domain permission", async () => {
    const response = await POST(
      new Request("http://localhost/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          name: "Server integration",
          scopes: ["asset:read", "kpi:read"],
          expiresInDays: 30,
        }),
      }),
    );

    expect(response?.status).toBe(201);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(scope, "site-a", "site:manage");
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(scope, "site-a", "asset:read");
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(scope, "site-a", "work:read");
    expect(mocks.createApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        scopes: ["asset:read", "kpi:read"],
        createdById: "manager-1",
      }),
    );
    await expect(response?.json()).resolves.toMatchObject({
      data: { apiKey: "gmao_sk_secret-once" },
    });
  });

  it("lists API key metadata without a reusable secret", async () => {
    mocks.listApiKeys.mockResolvedValue([
      {
        id: "key-record-1",
        name: "Server integration",
        scopes: ["asset:read"],
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
        revokedAt: null,
        createdAt: new Date("2026-08-07T20:00:00.000Z"),
        lastUsedAt: null,
      },
    ]);

    const response = await GET(
      new Request("http://localhost/api/api-keys?organizationId=org-a&siteId=site-a"),
    );
    const body = await response?.json();

    expect(response?.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("gmao_sk_");
  });

  it("refuses to revoke a non-API-key token through the API-key endpoint", async () => {
    mocks.isApiKeyRecord.mockResolvedValue(false);

    const response = await DELETE(
      new Request("http://localhost/api/api-keys", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          apiKeyId: "browser-token-1",
        }),
      }),
    );

    expect(response?.status).toBe(404);
    expect(mocks.tokenUpdateMany).not.toHaveBeenCalled();
  });
});
