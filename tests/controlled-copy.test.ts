import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  documentFindFirst: vi.fn(),
  auditCreate: vi.fn(),
  resolveEffectiveRevision: vi.fn(),
  readDocumentRevisionFile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    document: { findFirst: mocks.documentFindFirst },
    auditLog: { create: mocks.auditCreate },
  },
}));
vi.mock("@/lib/documents/workflow", () => ({
  resolveEffectiveRevision: mocks.resolveEffectiveRevision,
}));
vi.mock("@/lib/documents/files", () => ({
  readDocumentRevisionFile: mocks.readDocumentRevisionFile,
}));

import { issueControlledCopy } from "@/lib/documents/controlled-copy";

describe("controlled document copies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.documentFindFirst.mockResolvedValue({
      id: "doc-1",
      code: "WI-001",
      title: "Inspection instruction",
      type: "WORK_INSTRUCTION",
    });
    mocks.resolveEffectiveRevision.mockResolvedValue({
      id: "rev-b",
      documentId: "doc-1",
      revision: "B",
      status: "EFFECTIVE",
      effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
      expiresAt: null,
    });
    mocks.readDocumentRevisionFile.mockResolvedValue({
      data: new Uint8Array([1, 2, 3]),
      fileName: "inspection.pdf",
      mimeType: "application/pdf",
      checksum: "abc123",
      storageKey: "documents/org-a/doc-1/rev-b/abc123",
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("issues only the server-resolved effective revision and audits the copy", async () => {
    const asOf = new Date("2026-08-07T12:00:00.000Z");
    const result = await issueControlledCopy({
      organizationId: "org-a",
      documentId: "doc-1",
      actorId: "viewer-1",
      asOf,
    });

    expect(result.revision.revision).toBe("B");
    expect(result.file.checksum).toBe("abc123");
    expect(mocks.resolveEffectiveRevision).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      asOf,
    });
    expect(mocks.readDocumentRevisionFile).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-b",
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "viewer-1",
        entityType: "DocumentRevision",
        entityId: "rev-b",
        action: "CONTROLLED_COPY_ISSUED",
        afterJson: expect.stringContaining("abc123"),
      }),
    });
  });

  it("refuses a controlled copy when no revision is effective for the requested date", async () => {
    mocks.resolveEffectiveRevision.mockResolvedValue(null);

    await expect(
      issueControlledCopy({
        organizationId: "org-a",
        documentId: "doc-1",
        actorId: "viewer-1",
        asOf: new Date("2025-01-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "EFFECTIVE_REVISION_NOT_FOUND" });
    expect(mocks.readDocumentRevisionFile).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses to issue a copy when the stored effective file fails checksum verification", async () => {
    mocks.readDocumentRevisionFile.mockRejectedValue({ code: "FILE_INTEGRITY_FAILED" });

    await expect(
      issueControlledCopy({
        organizationId: "org-a",
        documentId: "doc-1",
        actorId: "viewer-1",
      }),
    ).rejects.toMatchObject({ code: "EFFECTIVE_FILE_UNAVAILABLE" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
