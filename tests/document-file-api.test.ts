import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  attach: vi.fn(),
  read: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/documents/files", () => ({
  attachDocumentRevisionFile: mocks.attach,
  readDocumentRevisionFile: mocks.read,
  DocumentFileError: class DocumentFileError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { GET, POST } from "@/app/api/documents/[documentId]/revisions/[revisionId]/file/route";

function auth(role: "QUALITY_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "QUALITY_MANAGER" ? "quality-1" : "tech-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role,
        allSites: true,
        siteIds: [],
        active: true,
      },
    },
  };
}

const context = {
  params: Promise.resolve({ documentId: "doc-1", revisionId: "rev-1" }),
};

function uploadRequest() {
  const form = new FormData();
  form.append("file", new Blob(["synthetic controlled file"], { type: "text/plain" }), "instruction.txt");
  return new Request(
    "http://localhost/api/documents/doc-1/revisions/rev-1/file?organizationId=org-a",
    { method: "POST", body: form },
  );
}

function downloadRequest() {
  return new Request(
    "http://localhost/api/documents/doc-1/revisions/rev-1/file?organizationId=org-a",
  );
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("controlled document file API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.attach.mockResolvedValue({
      id: "rev-1",
      storageKey: "documents/org-a/doc-1/rev-1/checksum",
      fileName: "instruction.txt",
      mimeType: "text/plain",
      checksum: "abc123",
    });
    mocks.read.mockResolvedValue({
      data: new TextEncoder().encode("synthetic controlled file"),
      fileName: "instruction.txt",
      mimeType: "text/plain",
      checksum: "abc123",
      storageKey: "documents/org-a/doc-1/rev-1/checksum",
    });
  });

  it("allows a document manager to upload a revision file", async () => {
    const response = await POST(uploadRequest(), context);

    await expectStatus(response, 201);
    expect(mocks.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        documentId: "doc-1",
        revisionId: "rev-1",
        actorId: "quality-1",
        fileName: "instruction.txt",
        mimeType: "text/plain",
        data: expect.any(Uint8Array),
      }),
    );
  });

  it("blocks a technician from replacing revision files", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await POST(uploadRequest(), context);

    await expectStatus(response, 403);
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("allows a document reader to download a checksum-verified revision file", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await GET(downloadRequest(), context);

    await expectStatus(response, 200);
    expect(response?.headers.get("content-type")).toBe("text/plain");
    expect(response?.headers.get("x-content-sha256")).toBe("abc123");
    expect(mocks.read).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-1",
    });
  });

  it("requires an explicit organization scope before file access", async () => {
    const response = await GET(
      new Request("http://localhost/api/documents/doc-1/revisions/rev-1/file"),
      context,
    );

    await expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
