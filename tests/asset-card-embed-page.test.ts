import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokenFindUnique: vi.fn(),
  getScopes: vi.fn(),
  createProof: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { publicMaintenanceRequestToken: { findUnique: mocks.tokenFindUnique } },
}));

vi.mock("@/lib/public-requests/tokens", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/public-requests/tokens")>();
  return { ...original, getPublicRequestTokenScopes: mocks.getScopes };
});

vi.mock("@/lib/embed/proof", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/embed/proof")>();
  return { ...original, createEmbedProof: mocks.createProof };
});

import { GET } from "@/app/embed/asset-card/route";

const token = {
  id: "token-asset",
  tokenHash: "hash",
  mode: "EMBEDDED" as const,
  allowedOrigins: ["https://portal.example.local"],
  revokedAt: null,
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-07T21:00:00.000Z"),
};

function request(referer = "https://portal.example.local/assets") {
  return new Request("http://localhost/embed/asset-card?tokenId=token-asset&assetCode=PUMP-100", {
    headers: { referer },
  });
}

describe("asset card iframe page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tokenFindUnique.mockResolvedValue(token);
    mocks.getScopes.mockResolvedValue(["asset:read"]);
    mocks.createProof.mockReturnValue("signed-proof");
  });

  it("renders only for an allowed parent origin and applies exact frame-ancestors", async () => {
    const response = await GET(request());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors https://portal.example.local",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(html).toContain('data-asset-code="PUMP-100"');
    expect(html).toContain('data-embed-proof="signed-proof"');
    expect(html).not.toContain("serialNumber");
  });

  it("does not render or sign a proof without asset:read", async () => {
    mocks.getScopes.mockResolvedValue(["maintenance:request:create"]);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(mocks.createProof).not.toHaveBeenCalled();
  });

  it("rejects a parent outside the exact origin allowlist", async () => {
    const response = await GET(request("https://evil.example.local/page"));

    expect(response.status).toBe(403);
    expect(mocks.createProof).not.toHaveBeenCalled();
  });
});
