import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokenFindUnique: vi.fn(),
  siteFindFirst: vi.fn(),
  resolveToken: vi.fn(),
  createRequest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    publicMaintenanceRequestToken: { findUnique: mocks.tokenFindUnique },
    site: { findFirst: mocks.siteFindFirst },
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

import { OPTIONS, POST } from "@/app/api/public/maintenance-requests/route";

const embeddedToken = {
  id: "token-1",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Embedded form",
  tokenHash: "hash",
  mode: "EMBEDDED",
  allowedOrigins: ["https://portal.example.local"],
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  revokedAt: null,
  createdById: "manager-1",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  lastUsedAt: null,
} as const;

function postRequest(origin = "https://portal.example.local") {
  return new Request(
    "http://localhost/api/public/maintenance-requests?tokenId=token-1",
    {
      method: "POST",
      headers: {
        authorization: "Bearer public-secret",
        "content-type": "application/json",
        "Idempotency-Key": "request-0001",
        origin,
      },
      body: JSON.stringify({
        title: "Machine noise reported",
        requesterEmail: "requester@example.local",
      }),
    },
  );
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("public maintenance request API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveToken.mockResolvedValue(embeddedToken);
    mocks.tokenFindUnique.mockResolvedValue(embeddedToken);
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

  it("answers CORS preflight only for an exact allowed embedded origin", async () => {
    const response = await OPTIONS(
      new Request(
        "http://localhost/api/public/maintenance-requests?tokenId=token-1",
        { method: "OPTIONS", headers: { origin: "https://portal.example.local" } },
      ),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://portal.example.local",
    );
  });

  it("rejects a cross-origin embedded request from an unconfigured origin", async () => {
    const response = await POST(postRequest("https://evil.example.local"));

    await expectStatus(response, 403);
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("creates a scoped request and returns exact CORS headers for an allowed origin", async () => {
    const response = await POST(postRequest());

    await expectStatus(response, 201);
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://portal.example.local",
    );
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
        token: embeddedToken,
        idempotencyKey: "request-0001",
        title: "Machine noise reported",
        origin: "https://portal.example.local",
      }),
    );
  });

  it("returns 200 for an idempotent retry", async () => {
    mocks.createRequest.mockResolvedValue({
      idempotent: true,
      workOrder: {
        id: "wo-1",
        number: "WO-P-DEMO",
        status: "REQUESTED",
        requestedAt: new Date("2026-08-07T12:00:00.000Z"),
      },
    });

    const response = await POST(postRequest());

    await expectStatus(response, 200);
  });

  it("rejects an invalid, expired or revoked bearer token", async () => {
    mocks.resolveToken.mockResolvedValue(null);

    const response = await POST(postRequest());

    await expectStatus(response, 401);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });
});
