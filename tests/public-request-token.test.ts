import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokenCreate: vi.fn(),
  tokenFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    publicMaintenanceRequestToken: {
      create: mocks.tokenCreate,
      findUnique: mocks.tokenFindUnique,
    },
  },
}));

import {
  createPublicRequestToken,
  hashPublicRequestToken,
  isOriginAllowed,
  normalizeAllowedOrigin,
  resolvePublicRequestToken,
} from "@/lib/public-requests/tokens";

describe("public maintenance request tokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores only a token hash and returns the raw secret once", async () => {
    mocks.tokenCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "token-1",
      organizationId: data.organizationId,
      siteId: data.siteId,
      name: data.name,
      mode: data.mode,
      allowedOrigins: data.allowedOrigins,
      expiresAt: data.expiresAt,
      createdAt: new Date("2026-08-07T12:00:00.000Z"),
    }));

    const result = await createPublicRequestToken({
      organizationId: "org-a",
      siteId: "site-a",
      name: "Public request form",
      mode: "EMBEDDED",
      allowedOrigins: ["https://portal.example.local"],
      createdById: "manager-1",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.token).toBeTruthy();
    const createCall = mocks.tokenCreate.mock.calls[0]?.[0];
    expect(createCall.data.tokenHash).toBe(hashPublicRequestToken(result.token));
    expect(createCall.data.tokenHash).not.toBe(result.token);
  });

  it("resolves a valid token and rejects expired or revoked records", async () => {
    const rawToken = "valid-public-request-token";
    const activeRecord = {
      id: "token-1",
      organizationId: "org-a",
      siteId: "site-a",
      name: "Public request form",
      tokenHash: hashPublicRequestToken(rawToken),
      mode: "PUBLIC",
      allowedOrigins: [],
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      revokedAt: null,
      createdById: "manager-1",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      lastUsedAt: null,
    } as const;

    mocks.tokenFindUnique.mockResolvedValue(activeRecord);
    await expect(
      resolvePublicRequestToken({
        tokenId: "token-1",
        token: rawToken,
        now: new Date("2026-08-07T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ id: "token-1", siteId: "site-a" });

    mocks.tokenFindUnique.mockResolvedValue({ ...activeRecord, revokedAt: new Date() });
    await expect(resolvePublicRequestToken({ tokenId: "token-1", token: rawToken })).resolves.toBeNull();

    mocks.tokenFindUnique.mockResolvedValue({
      ...activeRecord,
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await expect(
      resolvePublicRequestToken({
        tokenId: "token-1",
        token: rawToken,
        now: new Date("2026-08-07T12:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("requires exact configured origins for embedded tokens", () => {
    expect(normalizeAllowedOrigin("https://portal.example.local")).toBe("https://portal.example.local");
    expect(
      isOriginAllowed({
        mode: "EMBEDDED",
        allowedOrigins: ["https://portal.example.local"],
        origin: "https://portal.example.local",
      }),
    ).toBe(true);
    expect(
      isOriginAllowed({
        mode: "EMBEDDED",
        allowedOrigins: ["https://portal.example.local"],
        origin: "https://evil.example.local",
      }),
    ).toBe(false);
    expect(
      isOriginAllowed({
        mode: "EMBEDDED",
        allowedOrigins: ["https://portal.example.local"],
        origin: null,
      }),
    ).toBe(false);
  });

  it("rejects allowed-origin values containing a path or credentials", () => {
    expect(() => normalizeAllowedOrigin("https://portal.example.local/path")).toThrow();
    expect(() => normalizeAllowedOrigin("https://user:secret@portal.example.local")).toThrow();
  });
});
