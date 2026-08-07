import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveToken: vi.fn(),
  verifyProof: vi.fn(),
  issueDocument: vi.fn(),
}));

vi.mock("@/lib/public-requests/tokens", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/public-requests/tokens")>();
  return { ...original, resolvePublicRequestToken: mocks.resolveToken };
});
vi.mock("@/lib/embed/proof", () => ({ verifyEmbedProof: mocks.verifyProof }));
vi.mock("@/lib/public-documents/viewer", () => ({
  issuePublicControlledDocument: mocks.issueDocument,
  PublicDocumentViewerError: class PublicDocumentViewerError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
}));

import { GET } from "@/app/api/v1/embed/controlled-document/route";

const token = {
  id: "token-doc",
  organizationId: "org-a",
  siteId: "site-a",
  tokenHash: "hash",
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
    checksum: "b".repeat(64),
  },
  asOf: new Date("2026-08-07T12:00:00.000Z"),
};

function request() {
  return new Request("http://localhost/api/v1/embed/controlled-document?tokenId=token-doc&documentCode=SOP-100", {
    headers: {
      authorization: "Bearer scoped-token",
      "X-Embed-Proof": "signed-proof",
    },
  });
}

describe("controlled document embed API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveToken.mockResolvedValue(token);
    mocks.verifyProof.mockReturnValue({ parentOrigin: "https://portal.example.local" });
    mocks.issueDocument.mockResolvedValue(copy);
  });

  it("serves the same controlled binary using the validated parent origin", async () => {
    const response = await GET(request());

    expect(response?.status).toBe(200);
    expect(response?.headers.get("X-Controlled-Copy")).toBe("true");
    expect(mocks.issueDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        token,
        documentCode: "SOP-100",
        origin: "https://portal.example.local",
      }),
    );
  });

  it("rejects missing document:read before proof verification", async () => {
    mocks.resolveToken.mockResolvedValue({ ...token, scopes: ["asset:read"] });

    const response = await GET(request());

    expect(response?.status).toBe(403);
    expect(mocks.verifyProof).not.toHaveBeenCalled();
    expect(mocks.issueDocument).not.toHaveBeenCalled();
  });

  it("rejects an invalid embed proof", async () => {
    mocks.verifyProof.mockReturnValue(null);

    const response = await GET(request());

    expect(response?.status).toBe(403);
    expect(mocks.issueDocument).not.toHaveBeenCalled();
  });
});
