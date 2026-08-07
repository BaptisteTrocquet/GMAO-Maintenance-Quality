import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveToken: vi.fn(),
  siteFindFirst: vi.fn(),
  createRequest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/public-requests/tokens", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/public-requests/tokens")>();
  return { ...original, resolvePublicRequestToken: mocks.resolveToken };
});
vi.mock("@/lib/public-requests/create-request", () => ({
  createPublicMaintenanceRequest: mocks.createRequest,
  PublicMaintenanceRequestError: class PublicMaintenanceRequestError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { POST } from "@/app/api/v1/embed/maintenance-requests/route";
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
    "http://gmao.example.test/api/v1/embed/maintenance-requests?tokenId=token-1",
    {
      method: "POST",
      headers: {
        authorization: "Bearer scoped-secret",
        "content-type": "application/json",
        "Idempotency-Key": "embed-request-0001",
        "X-Embed-Proof": proof,
      },
      body: JSON.stringify({
        title: "Abnormal equipment noise",
        requesterEmail: "requester@example.test",
      }),
    },
  );
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("iframe maintenance request API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveToken.mockResolvedValue(token);
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.createRequest.mockResolvedValue({
      idempotent: false,
      workOrder: {
        id: "wo-1",
        number: "WO-P-DEMO",
        status: "REQUESTED",
        requestedAt: new Date("2026-08-07T12:00:00.000Z"),
      },
    });
  });

  it("creates through the shared public-request domain using the signed parent origin", async () => {
    const proof = createEmbedProof({
      tokenId: token.id,
      tokenHash,
      parentOrigin: "https://portal.example.test",
    });

    const response = await POST(request(proof));

    await expectStatus(response, 201);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: {
        id: "site-a",
        organizationId: "org-a",
        active: true,
        organization: { active: true },
      },
      select: { id: true },
    });
    expect(mocks.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        token,
        idempotencyKey: "embed-request-0001",
        title: "Abnormal equipment noise",
        origin: "https://portal.example.test",
      }),
    );
  });

  it("rejects a tampered or expired embed proof before creating work", async () => {
    const response = await POST(request("invalid.proof"));

    await expectStatus(response, 403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("does not accept a PUBLIC token on the iframe-only endpoint", async () => {
    mocks.resolveToken.mockResolvedValue({ ...token, mode: "PUBLIC" });
    const proof = createEmbedProof({
      tokenId: token.id,
      tokenHash,
      parentOrigin: "https://portal.example.test",
    });

    const response = await POST(request(proof));

    await expectStatus(response, 401);
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("requires both the scoped bearer secret and short-lived embed proof", async () => {
    const response = await POST(
      new Request("http://gmao.example.test/api/v1/embed/maintenance-requests?tokenId=token-1", {
        method: "POST",
        headers: { authorization: "Bearer scoped-secret" },
      }),
    );

    await expectStatus(response, 401);
    expect(mocks.resolveToken).not.toHaveBeenCalled();
  });
});
