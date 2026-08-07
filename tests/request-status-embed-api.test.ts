import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveToken: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock("@/lib/public-requests/tokens", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/public-requests/tokens")>();
  return { ...original, resolvePublicRequestToken: mocks.resolveToken };
});
vi.mock("@/lib/public-requests/status", () => ({
  getPublicMaintenanceRequestStatus: mocks.getStatus,
  PublicRequestStatusError: class PublicRequestStatusError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { GET } from "@/app/api/v1/embed/request-status/route";
import { createEmbedProof } from "@/lib/embed/proof";

const tokenHash = "ab".repeat(32);
const token = {
  id: "token-1",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Portal embed",
  tokenHash,
  mode: "EMBEDDED",
  allowedOrigins: ["https://portal.example.test"],
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  revokedAt: null,
  createdById: "manager-1",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  lastUsedAt: null,
} as const;

function request(proof: string) {
  return new Request(
    "http://gmao.example.test/api/v1/embed/request-status?tokenId=token-1&trackingId=submission-1",
    {
      headers: {
        authorization: "Bearer scoped-secret",
        "X-Embed-Proof": proof,
      },
    },
  );
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("iframe request status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveToken.mockResolvedValue(token);
    mocks.getStatus.mockResolvedValue({
      trackingId: "submission-1",
      workOrder: { number: "WO-P-001", status: "IN_PROGRESS" },
    });
  });

  it("reads status through the shared scoped service using the signed parent origin", async () => {
    const proof = createEmbedProof({
      tokenId: token.id,
      tokenHash,
      parentOrigin: "https://portal.example.test",
    });

    const response = await GET(request(proof));

    await expectStatus(response, 200);
    expect(mocks.getStatus).toHaveBeenCalledWith({
      token,
      trackingId: "submission-1",
      origin: "https://portal.example.test",
    });
  });

  it("rejects a tampered embed proof before reading status", async () => {
    const response = await GET(request("invalid.proof"));

    await expectStatus(response, 403);
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it("rejects PUBLIC-mode tokens on the iframe-only endpoint", async () => {
    mocks.resolveToken.mockResolvedValue({ ...token, mode: "PUBLIC" });
    const proof = createEmbedProof({
      tokenId: token.id,
      tokenHash,
      parentOrigin: "https://portal.example.test",
    });

    const response = await GET(request(proof));

    await expectStatus(response, 401);
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });
});
