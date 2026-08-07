import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveToken: vi.fn(),
  verifyProof: vi.fn(),
  getCard: vi.fn(),
}));

vi.mock("@/lib/public-requests/tokens", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/public-requests/tokens")>();
  return { ...original, resolvePublicRequestToken: mocks.resolveToken };
});

vi.mock("@/lib/embed/proof", () => ({ verifyEmbedProof: mocks.verifyProof }));
vi.mock("@/lib/public-assets/card", () => ({
  getPublicAssetCard: mocks.getCard,
  PublicAssetCardError: class PublicAssetCardError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { GET } from "@/app/api/v1/embed/asset-card/route";

const token = {
  id: "token-asset",
  organizationId: "org-a",
  siteId: "site-a",
  tokenHash: "hash",
  mode: "EMBEDDED" as const,
  allowedOrigins: ["https://portal.example.local"],
  scopes: ["asset:read"],
};

function request() {
  return new Request("http://localhost/api/v1/embed/asset-card?tokenId=token-asset&assetCode=PUMP-100", {
    headers: {
      authorization: "Bearer scoped-token",
      "X-Embed-Proof": "signed-proof",
    },
  });
}

describe("asset card embed API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveToken.mockResolvedValue(token);
    mocks.verifyProof.mockReturnValue({ parentOrigin: "https://portal.example.local" });
    mocks.getCard.mockResolvedValue({ code: "PUMP-100", name: "Transfer pump" });
  });

  it("uses the validated parent origin for the scoped lookup", async () => {
    const response = await GET(request());

    expect(response?.status).toBe(200);
    expect(mocks.getCard).toHaveBeenCalledWith({
      token,
      assetCode: "PUMP-100",
      origin: "https://portal.example.local",
    });
  });

  it("rejects a token without asset:read before proof validation", async () => {
    mocks.resolveToken.mockResolvedValue({ ...token, scopes: ["maintenance:request:status"] });

    const response = await GET(request());

    expect(response?.status).toBe(403);
    expect(mocks.verifyProof).not.toHaveBeenCalled();
    expect(mocks.getCard).not.toHaveBeenCalled();
  });

  it("rejects an invalid proof before reading the asset", async () => {
    mocks.verifyProof.mockReturnValue(null);

    const response = await GET(request());

    expect(response?.status).toBe(403);
    expect(mocks.getCard).not.toHaveBeenCalled();
  });
});
