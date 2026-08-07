import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  tokenCreate: vi.fn(),
  auditCreate: vi.fn(),
  tokenFindUnique: vi.fn(),
  auditFindFirst: vi.fn(),
  tokenUpdate: vi.fn(),
}));

const tx = {
  publicMaintenanceRequestToken: { create: mocks.tokenCreate },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    publicMaintenanceRequestToken: {
      findUnique: mocks.tokenFindUnique,
      update: mocks.tokenUpdate,
    },
    auditLog: { findFirst: mocks.auditFindFirst },
  },
}));

import {
  authenticateApiKeyRequest,
  createApiKey,
  resolveApiKey,
} from "@/lib/integrations/api-keys";
import { hashPublicRequestToken } from "@/lib/public-requests/tokens";

describe("server API keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.tokenCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "key-record-1",
      organizationId: data.organizationId,
      siteId: data.siteId,
      name: data.name,
      expiresAt: data.expiresAt,
      createdAt: new Date("2026-08-07T20:00:00.000Z"),
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.tokenUpdate.mockResolvedValue({ id: "key-record-1" });
  });

  it("returns the raw API key once while storing only its hash and immutable scopes", async () => {
    const result = await createApiKey({
      organizationId: "org-a",
      siteId: "site-a",
      name: "Server integration",
      scopes: ["asset:read", "kpi:read"],
      createdById: "manager-1",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.apiKey).toMatch(/^gmao_sk_/);
    const createCall = mocks.tokenCreate.mock.calls[0]?.[0];
    expect(createCall.data.tokenHash).toBe(hashPublicRequestToken(result.apiKey));
    expect(createCall.data.tokenHash).not.toBe(result.apiKey);
    expect(createCall.data.mode).toBe("EMBEDDED");
    expect(createCall.data.allowedOrigins).toEqual([]);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "PublicMaintenanceRequestToken",
        entityId: "key-record-1",
        action: "CREATED",
        afterJson: expect.stringContaining('"credentialKind":"API_KEY"'),
      }),
    });
  });

  it("resolves only API_KEY records with no browser origins", async () => {
    const raw = "gmao_sk_server-secret";
    mocks.tokenFindUnique.mockResolvedValue({
      id: "key-record-1",
      organizationId: "org-a",
      siteId: "site-a",
      name: "Server integration",
      tokenHash: hashPublicRequestToken(raw),
      mode: "EMBEDDED",
      allowedOrigins: [],
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      revokedAt: null,
      createdById: "manager-1",
      createdAt: new Date("2026-08-07T20:00:00.000Z"),
      lastUsedAt: null,
    });
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify({
        credentialKind: "API_KEY",
        scopes: ["asset:read"],
      }),
    });

    await expect(resolveApiKey(raw, new Date("2026-08-08T00:00:00.000Z"))).resolves.toMatchObject({
      id: "key-record-1",
      scopes: ["asset:read"],
    });

    mocks.tokenFindUnique.mockResolvedValue({
      ...(await resolveApiKey(raw, new Date("2026-08-08T00:00:00.000Z"))),
      tokenHash: hashPublicRequestToken(raw),
      allowedOrigins: ["https://portal.example.test"],
      revokedAt: null,
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await expect(resolveApiKey(raw)).resolves.toBeNull();
  });

  it("forbids API keys on browser-origin requests before reading the secret", async () => {
    const result = await authenticateApiKeyRequest(
      new Request("http://localhost/api/v1/server/assets", {
        headers: {
          Origin: "https://portal.example.test",
          "X-API-Key": "gmao_sk_server-secret",
        },
      }),
      "asset:read",
    );

    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(403);
    expect(mocks.tokenFindUnique).not.toHaveBeenCalled();
  });

  it("rejects a valid API key that lacks the required capability", async () => {
    const raw = "gmao_sk_server-secret";
    mocks.tokenFindUnique.mockResolvedValue({
      id: "key-record-1",
      organizationId: "org-a",
      siteId: "site-a",
      name: "Server integration",
      tokenHash: hashPublicRequestToken(raw),
      mode: "EMBEDDED",
      allowedOrigins: [],
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      revokedAt: null,
      createdById: "manager-1",
      createdAt: new Date("2026-08-07T20:00:00.000Z"),
      lastUsedAt: null,
    });
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify({ credentialKind: "API_KEY", scopes: ["asset:read"] }),
    });

    const result = await authenticateApiKeyRequest(
      new Request("http://localhost/api/v1/server/kpis", {
        headers: { "X-API-Key": raw },
      }),
      "kpi:read",
    );

    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(403);
    expect(mocks.tokenUpdate).not.toHaveBeenCalled();
  });
});
