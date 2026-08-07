import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokenFindUnique: vi.fn(),
  resolveToken: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { publicMaintenanceRequestToken: { findUnique: mocks.tokenFindUnique } },
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

import { GET, OPTIONS } from "@/app/api/v1/public/request-status/route";

const token = {
  id: "token-1",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Portal token",
  tokenHash: "hash",
  mode: "EMBEDDED",
  allowedOrigins: ["https://portal.example.test"],
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  revokedAt: null,
  createdById: "manager-1",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  lastUsedAt: null,
} as const;

function getRequest(origin = "https://portal.example.test") {
  return new Request(
    "http://gmao.example.test/api/v1/public/request-status?tokenId=token-1&trackingId=submission-1",
    {
      headers: {
        authorization: "Bearer scoped-secret",
        origin,
      },
    },
  );
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("public request status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tokenFindUnique.mockResolvedValue(token);
    mocks.resolveToken.mockResolvedValue(token);
    mocks.getStatus.mockResolvedValue({
      trackingId: "submission-1",
      workOrder: {
        number: "WO-P-001",
        status: "IN_PROGRESS",
        requestedAt: new Date("2026-08-07T10:00:00.000Z"),
        plannedStart: null,
        dueAt: null,
        startedAt: null,
        completedAt: null,
        updatedAt: new Date("2026-08-07T11:00:00.000Z"),
      },
    });
  });

  it("answers preflight only for the exact allowed embedded origin", async () => {
    const response = await OPTIONS(
      new Request("http://gmao.example.test/api/v1/public/request-status?tokenId=token-1", {
        method: "OPTIONS",
        headers: { origin: "https://portal.example.test" },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://portal.example.test");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("returns scoped status with exact CORS headers", async () => {
    const response = await GET(getRequest());

    await expectStatus(response, 200);
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("https://portal.example.test");
    expect(mocks.getStatus).toHaveBeenCalledWith({
      token,
      trackingId: "submission-1",
      origin: "https://portal.example.test",
    });
  });

  it("rejects an unconfigured browser origin before reading status", async () => {
    const response = await GET(getRequest("https://evil.example.test"));

    await expectStatus(response, 403);
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it("rejects invalid, expired or revoked scoped bearer tokens", async () => {
    mocks.resolveToken.mockResolvedValue(null);

    const response = await GET(getRequest());

    await expectStatus(response, 401);
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });
});
