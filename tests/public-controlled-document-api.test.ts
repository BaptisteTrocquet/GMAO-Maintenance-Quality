import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveToken: vi.fn(),
  issueDocument: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { publicMaintenanceRequestToken: { findUnique: vi.fn() } } }));
vi.mock("@/lib/public-requests/tokens", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/public-requests/tokens")>();
  return { ...original, resolvePublicRequestToken: mocks.resolveToken };
});
vi.mock("@/lib/public-documents/viewer", () => ({
  issuePublicControlledDocument: mocks.issueDocument,
  PublicDocumentViewerError: class PublicDocumentViewerError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
}));

import { GET } from "@/app/api/v1/public/documents/route";

const token = {
  id: "token-doc",
  organizationId: "org-a",
  siteId: "site-a",
  mode: "EMBEDDED" as const,
  allowedOrigins: ["https://portal.example.local"],
  scopes: ["document:read"],
};

const copy = {
  document: { code: "SOP-100", title: "Safe operating procedure" },
  revision: { revision: "3", effectiveAt: new Date("2026-08-01T00:00:00.000Z") },
  file: {
    data: new Uint8Array([1, 2, 3]),
    mimeType: "application/pdf",
    fileName: "SOP-100-r3.pdf",
    checksum: "a".repeat(64),
  },
  asOf: new Date("2026-08-07T12:00:00.000Z"),
};

function request(origin = "https://portal.example.local") {
  return new Request("http://localhost/api/v1/public/documents?tokenId=token-doc&documentCode=SOP-100&asOf=2026-08-07T12:00:00.000Z", {
    headers: { authorization: "Bearer scoped-token", origin },
  });
}

describe("public controlled document API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveToken.mockResolvedValue(token);
    mocks.issueDocument.mockResolvedValue(copy);
  });

  it("serves only the controlled copy and exposes traceability headers through CORS", async () => {
    const response = await GET(request());

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("https://portal.example.local");
    expect(response?.headers.get("X-Controlled-Copy")).toBe("true");
    expect(response?.headers.get("X-Document-Revision")).toBe("3");
    expect(response?.headers.get("X-Content-SHA256")).toBe("a".repeat(64));
    expect(mocks.issueDocument).toHaveBeenCalledWith({
      token,
      documentCode: "SOP-100",
      asOf: new Date("2026-08-07T12:00:00.000Z"),
      origin: "https://portal.example.local",
    });
  });

  it("rejects a token without document:read", async () => {
    mocks.resolveToken.mockResolvedValue({ ...token, scopes: ["asset:read"] });

    const response = await GET(request());

    expect(response?.status).toBe(403);
    expect(mocks.issueDocument).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured browser origin", async () => {
    const response = await GET(request("https://evil.example.local"));

    expect(response?.status).toBe(403);
    expect(mocks.issueDocument).not.toHaveBeenCalled();
  });
});
