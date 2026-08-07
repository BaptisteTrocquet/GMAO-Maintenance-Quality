import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  issueControlledCopy: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/documents/controlled-copy", () => ({
  issueControlledCopy: mocks.issueControlledCopy,
  ControlledCopyError: class ControlledCopyError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { GET } from "@/app/api/documents/[documentId]/controlled-copy/route";

const auth = {
  session: { user: { id: "viewer-1" } },
  tenant: {
    scope: {
      organizationId: "org-a",
      role: "VIEWER",
      allSites: true,
      siteIds: [],
      active: true,
    },
  },
};

function requireResponse(response: Response | undefined): Response {
  expect(response).toBeDefined();
  return response!;
}

describe("controlled copy API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.issueControlledCopy.mockResolvedValue({
      document: { id: "doc-1", code: "WI-001", title: "Inspection", type: "WORK_INSTRUCTION" },
      revision: {
        id: "rev-b",
        revision: "B",
        status: "EFFECTIVE",
        effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
        expiresAt: null,
      },
      file: {
        data: new Uint8Array([1, 2, 3]),
        fileName: "inspection.pdf",
        mimeType: "application/pdf",
        checksum: "abc123",
        storageKey: "documents/org-a/doc-1/rev-b/abc123",
      },
      issuedAt: new Date("2026-08-07T12:00:00.000Z"),
      asOf: new Date("2026-08-07T12:00:00.000Z"),
    });
  });

  it("serves a no-store controlled copy with revision and checksum metadata", async () => {
    const response = requireResponse(
      await GET(
        new Request(
          "http://localhost/api/documents/doc-1/controlled-copy?organizationId=org-a&asOf=2026-08-07T12:00:00.000Z",
        ),
        { params: Promise.resolve({ documentId: "doc-1" }) },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Controlled-Copy")).toBe("true");
    expect(response.headers.get("X-Document-Code")).toBe("WI-001");
    expect(response.headers.get("X-Document-Revision")).toBe("B");
    expect(response.headers.get("X-Content-SHA256")).toBe("abc123");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.issueControlledCopy).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      actorId: "viewer-1",
      asOf: new Date("2026-08-07T12:00:00.000Z"),
    });
  });

  it("requires explicit organization scope", async () => {
    const response = requireResponse(
      await GET(
        new Request("http://localhost/api/documents/doc-1/controlled-copy"),
        { params: Promise.resolve({ documentId: "doc-1" }) },
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });

  it("rejects an invalid as-of date before authentication", async () => {
    const response = requireResponse(
      await GET(
        new Request("http://localhost/api/documents/doc-1/controlled-copy?organizationId=org-a&asOf=not-a-date"),
        { params: Promise.resolve({ documentId: "doc-1" }) },
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
