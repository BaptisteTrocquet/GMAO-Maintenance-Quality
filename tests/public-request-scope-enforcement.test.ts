import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveToken: vi.fn(),
  createRequest: vi.fn(),
  getStatus: vi.fn(),
  verifyProof: vi.fn(),
  siteFindFirst: vi.fn(),
  tokenFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    publicMaintenanceRequestToken: { findUnique: mocks.tokenFindUnique },
  },
}));

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

vi.mock("@/lib/public-requests/status", () => ({
  getPublicMaintenanceRequestStatus: mocks.getStatus,
  PublicRequestStatusError: class PublicRequestStatusError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

vi.mock("@/lib/embed/proof", () => ({
  verifyEmbedProof: mocks.verifyProof,
}));

import { POST as createPublicRequest } from "@/app/api/public/maintenance-requests/route";
import { POST as createEmbeddedRequest } from "@/app/api/v1/embed/maintenance-requests/route";
import { GET as getPublicStatus } from "@/app/api/v1/public/request-status/route";
import { GET as getEmbeddedStatus } from "@/app/api/v1/embed/request-status/route";

const baseToken = {
  id: "token-1",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Scoped integration",
  tokenHash: "hash",
  mode: "EMBEDDED" as const,
  allowedOrigins: ["https://portal.example.local"],
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  revokedAt: null,
  createdById: "manager-1",
  createdAt: new Date("2026-08-07T21:00:00.000Z"),
  lastUsedAt: null,
};

function publicCreateRequest() {
  return new Request("http://localhost/api/public/maintenance-requests?tokenId=token-1", {
    method: "POST",
    headers: {
      authorization: "Bearer scoped-secret",
      origin: "https://portal.example.local",
      "content-type": "application/json",
      "Idempotency-Key": "request-0001",
    },
    body: JSON.stringify({ title: "Unexpected vibration" }),
  });
}

function embeddedCreateRequest() {
  return new Request("http://localhost/api/v1/embed/maintenance-requests?tokenId=token-1", {
    method: "POST",
    headers: {
      authorization: "Bearer scoped-secret",
      "X-Embed-Proof": "signed-proof",
      "content-type": "application/json",
      "Idempotency-Key": "request-0001",
    },
    body: JSON.stringify({ title: "Unexpected vibration" }),
  });
}

function publicStatusRequest() {
  return new Request(
    "http://localhost/api/v1/public/request-status?tokenId=token-1&trackingId=tracking-1",
    {
      headers: {
        authorization: "Bearer scoped-secret",
        origin: "https://portal.example.local",
      },
    },
  );
}

function embeddedStatusRequest() {
  return new Request(
    "http://localhost/api/v1/embed/request-status?tokenId=token-1&trackingId=tracking-1",
    {
      headers: {
        authorization: "Bearer scoped-secret",
        "X-Embed-Proof": "signed-proof",
      },
    },
  );
}

describe("public request capability enforcement", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks maintenance creation for a token scoped only to asset reads", async () => {
    mocks.resolveToken.mockResolvedValue({ ...baseToken, scopes: ["asset:read"] });

    const publicResponse = await createPublicRequest(publicCreateRequest());
    const embedResponse = await createEmbeddedRequest(embeddedCreateRequest());

    expect(publicResponse?.status).toBe(403);
    expect(embedResponse?.status).toBe(403);
    expect(mocks.createRequest).not.toHaveBeenCalled();
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.verifyProof).not.toHaveBeenCalled();
  });

  it("blocks request-status reads for a token scoped only to creation", async () => {
    mocks.resolveToken.mockResolvedValue({
      ...baseToken,
      scopes: ["maintenance:request:create"],
    });

    const publicResponse = await getPublicStatus(publicStatusRequest());
    const embedResponse = await getEmbeddedStatus(embeddedStatusRequest());

    expect(publicResponse?.status).toBe(403);
    expect(embedResponse?.status).toBe(403);
    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(mocks.verifyProof).not.toHaveBeenCalled();
  });
});
