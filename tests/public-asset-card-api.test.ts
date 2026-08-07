import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveToken: vi.fn(),
  getCard: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { publicMaintenanceRequestToken: { findUnique: vi.fn() } } }));

vi.mock("@/lib/public-requests/tokens", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/public-requests/tokens")>();
  return { ...original, resolvePublicRequestToken: mocks.resolveToken };
});

vi.mock("@/lib/public-assets/card", () => ({
  getPublicAssetCard: mocks.getCard,
  PublicAssetCardError: class PublicAssetCardError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { GET } from "@/app/api/v1/public/assets/route";

const token = {
  id: "token-asset",
  organizationId: "org-a",
  siteId: "site-a",
  mode: "EMBEDDED" as const,
  allowedOrigins: ["https://portal.example.local"],
  scopes: ["asset:read"],
};

function request(origin = "https://portal.example.local") {
  return new Request("http://localhost/api/v1/public/assets?tokenId=token-asset&assetCode=PUMP-100", {
    headers: { authorization: "Bearer scoped-token", origin },
  });
}

describe("public asset card API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveToken.mockResolvedValue(token);
    mocks.getCard.mockResolvedValue({
      code: "PUMP-100",
      name: "Transfer pump",
      status: "ACTIVE",
      criticality: "HIGH",
      category: "Pump",
      manufacturer: null,
      model: null,
      updatedAt: new Date("2026-08-07T12:00:00.000Z"),
      location: null,
    });
  });

  it("returns a minimal asset card with exact CORS for an allowed origin", async () => {
    const response = await GET(request());

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("https://portal.example.local");
    expect(mocks.getCard).toHaveBeenCalledWith({
      token,
      assetCode: "PUMP-100",
      origin: "https://portal.example.local",
    });
  });

  it("rejects an origin outside the token allowlist", async () => {
    const response = await GET(request("https://evil.example.local"));

    expect(response?.status).toBe(403);
    expect(mocks.getCard).not.toHaveBeenCalled();
  });

  it("rejects a valid token without asset:read", async () => {
    mocks.resolveToken.mockResolvedValue({ ...token, scopes: ["maintenance:request:create"] });

    const response = await GET(request());

    expect(response?.status).toBe(403);
    expect(mocks.getCard).not.toHaveBeenCalled();
  });
});
