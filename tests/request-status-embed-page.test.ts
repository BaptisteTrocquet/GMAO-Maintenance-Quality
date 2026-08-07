import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokenFindUnique: vi.fn(),
  submissionFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    publicMaintenanceRequestToken: { findUnique: mocks.tokenFindUnique },
    publicMaintenanceRequestSubmission: { findFirst: mocks.submissionFindFirst },
  },
}));

import { GET } from "@/app/embed/request-status/route";

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

describe("request status iframe shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tokenFindUnique.mockResolvedValue(token);
    mocks.submissionFindFirst.mockResolvedValue({ id: "submission-1" });
  });

  it("renders only a tracking id owned by the scoped token and exact parent origin", async () => {
    const response = await GET(
      new Request(
        "http://gmao.example.test/embed/request-status?tokenId=token-1&trackingId=submission-1",
        { headers: { referer: "https://portal.example.test/maintenance" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.submissionFindFirst).toHaveBeenCalledWith({
      where: { id: "submission-1", tokenId: "token-1" },
      select: { id: true },
    });
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors https://portal.example.test",
    );
    const html = await response.text();
    expect(html).toContain('data-tracking-id="submission-1"');
    expect(html).toContain("data-embed-proof=");
  });

  it("does not reveal whether another token owns a tracking id", async () => {
    mocks.submissionFindFirst.mockResolvedValue(null);

    const response = await GET(
      new Request(
        "http://gmao.example.test/embed/request-status?tokenId=token-1&trackingId=foreign-submission",
        { headers: { referer: "https://portal.example.test/maintenance" } },
      ),
    );

    expect(response.status).toBe(404);
  });

  it("rejects an unconfigured parent origin", async () => {
    const response = await GET(
      new Request(
        "http://gmao.example.test/embed/request-status?tokenId=token-1&trackingId=submission-1",
        { headers: { referer: "https://evil.example.test/page" } },
      ),
    );

    expect(response.status).toBe(403);
  });
});
