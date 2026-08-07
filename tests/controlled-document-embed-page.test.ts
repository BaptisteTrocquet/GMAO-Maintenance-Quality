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

import { GET } from "@/app/embed/controlled-document/route";

const token = {
  id: "token-doc",
  tokenHash: "hash",
  mode: "EMBEDDED" as const,
  allowedOrigins: ["https://portal.example.local"],
  revokedAt: null,
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-07T21:00:00.000Z"),
};

function request(documentCode = "SOP-100", referer = "https://portal.example.local/docs") {
  const url = new URL("http://localhost/embed/controlled-document");
  url.searchParams.set("tokenId", "token-doc");
  url.searchParams.set("documentCode", documentCode);
  return new Request(url, { headers: { referer } });
}

describe("controlled document viewer page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tokenFindUnique.mockResolvedValue(token);
    mocks.getScopes.mockResolvedValue(["document:read"]);
    mocks.createProof.mockReturnValue("signed-proof");
  });

  it("uses restrictive CSP while allowing only blob PDF/image previews", async () => {
    const response = await GET(request());
    const html = await response.text();
    const csp = response.headers.get("Content-Security-Policy") || "";

    expect(response.status).toBe(200);
    expect(csp).toContain("frame-ancestors https://portal.example.local");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src blob:");
    expect(csp).toContain("img-src blob:");
    expect(html).toContain("sandbox");
  });

  it("escapes a hostile document code instead of injecting markup", async () => {
    const hostile = 'DOC\"><script src="https://evil.example/script.js"></script>';
    const response = await GET(request(hostile));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain('<script src="https://evil.example/script.js">');
    expect(html).toContain("&quot;&gt;&lt;script");
  });

  it("does not render or sign a proof without document:read", async () => {
    mocks.getScopes.mockResolvedValue(["asset:read"]);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(mocks.createProof).not.toHaveBeenCalled();
  });

  it("rejects a parent outside the exact origin allowlist", async () => {
    const response = await GET(request("SOP-100", "https://evil.example.local/page"));

    expect(response.status).toBe(403);
    expect(mocks.createProof).not.toHaveBeenCalled();
  });
});
