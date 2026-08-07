import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tokenFindUnique: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { publicMaintenanceRequestToken: { findUnique: mocks.tokenFindUnique } },
}));

import { GET } from "@/app/embed/maintenance-request/route";

const token = {
  id: "token-1",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Portal embed",
  tokenHash: "ab".repeat(32),
  mode: "EMBEDDED",
  allowedOrigins: ["https://portal.example.test"],
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  revokedAt: null,
  createdById: "manager-1",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  lastUsedAt: null,
} as const;

describe("maintenance request iframe shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tokenFindUnique.mockResolvedValue(token);
  });

  it("renders only for an exact allowed embedding origin with a strict CSP", async () => {
    const response = await GET(
      new Request("http://gmao.example.test/embed/maintenance-request?tokenId=token-1", {
        headers: { referer: "https://portal.example.test/maintenance" },
      }),
    );

    expect(response.status).toBe(200);
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors https://portal.example.test");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const html = await response.text();
    expect(html).toContain("data-embed-proof=");
    expect(html).toContain("/embed/maintenance-request/client.js");
    expect(html).toContain("/embed/theme.css?");
    expect(html).not.toContain("tokenHash");
  });

  it("renders only server-validated theme tokens into the stylesheet URL", async () => {
    const response = await GET(
      new Request(
        "http://gmao.example.test/embed/maintenance-request?tokenId=token-1&themeAccent=%23AABBCC&themeSurface=red%3Bbody%7Bdisplay%3Anone%7D&themeRadius=12",
        { headers: { referer: "https://portal.example.test/maintenance" } },
      ),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("accent=%23aabbcc");
    expect(html).toContain("radius=12");
    expect(html).not.toContain("display%3Anone");
    expect(html).not.toContain("display:none");
  });

  it("rejects an iframe loaded by an unconfigured parent origin", async () => {
    const response = await GET(
      new Request("http://gmao.example.test/embed/maintenance-request?tokenId=token-1", {
        headers: { referer: "https://evil.example.test/page" },
      }),
    );

    expect(response.status).toBe(403);
  });

  it("fails closed when the browser does not provide a parent referrer", async () => {
    const response = await GET(
      new Request("http://gmao.example.test/embed/maintenance-request?tokenId=token-1"),
    );

    expect(response.status).toBe(403);
  });

  it("does not render a revoked embedded token", async () => {
    mocks.tokenFindUnique.mockResolvedValue({ ...token, revokedAt: new Date() });

    const response = await GET(
      new Request("http://gmao.example.test/embed/maintenance-request?tokenId=token-1", {
        headers: { referer: "https://portal.example.test/page" },
      }),
    );

    expect(response.status).toBe(404);
  });
});
