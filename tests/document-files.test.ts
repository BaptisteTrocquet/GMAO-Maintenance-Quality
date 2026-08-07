import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "@/lib/storage";

const mocks = vi.hoisted(() => ({
  revisionFindFirst: vi.fn(),
  revisionUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    documentRevision: {
      findFirst: mocks.revisionFindFirst,
      update: mocks.revisionUpdate,
    },
    auditLog: { create: mocks.auditCreate },
  },
}));

import {
  attachDocumentRevisionFile,
  readDocumentRevisionFile,
  sha256Hex,
} from "@/lib/documents/files";

class MemoryStorage implements StorageAdapter {
  files = new Map<string, Uint8Array>();
  deleted: string[] = [];

  async put(key: string, data: Uint8Array) {
    this.files.set(key, new Uint8Array(data));
    return key;
  }

  async get(key: string) {
    const data = this.files.get(key);
    if (!data) throw new Error("missing file");
    return new Uint8Array(data);
  }

  async delete(key: string) {
    this.deleted.push(key);
    this.files.delete(key);
  }
}

const bytes = new TextEncoder().encode("synthetic controlled document content");
const checksum = sha256Hex(bytes);

function draftRevision(overrides: Record<string, unknown> = {}) {
  return {
    id: "rev-1",
    documentId: "doc-1",
    revision: "A",
    status: "DRAFT",
    storageKey: null,
    fileName: null,
    mimeType: null,
    checksum: null,
    ...overrides,
  };
}

describe("controlled document file storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.revisionFindFirst.mockResolvedValue(draftRevision());
    mocks.revisionUpdate.mockResolvedValue({
      ...draftRevision(),
      storageKey: `documents/org-a/doc-1/rev-1/${checksum}`,
      fileName: "instruction.txt",
      mimeType: "text/plain",
      checksum,
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("stores a DRAFT revision by SHA-256 and records file metadata", async () => {
    const adapter = new MemoryStorage();

    const result = await attachDocumentRevisionFile({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-1",
      actorId: "quality-1",
      fileName: "instruction.txt",
      mimeType: "text/plain",
      data: bytes,
      adapter,
    });

    const key = `documents/org-a/doc-1/rev-1/${checksum}`;
    expect(adapter.files.get(key)).toEqual(bytes);
    expect(result.checksum).toBe(checksum);
    expect(mocks.revisionUpdate).toHaveBeenCalledWith({
      where: { id: "rev-1" },
      data: {
        storageKey: key,
        fileName: "instruction.txt",
        mimeType: "text/plain",
        checksum,
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "quality-1",
        entityType: "DocumentRevision",
        entityId: "rev-1",
        action: "FILE_ATTACHED",
      }),
    });
  });

  it("rejects file replacement after a revision leaves DRAFT", async () => {
    const adapter = new MemoryStorage();
    mocks.revisionFindFirst.mockResolvedValue(draftRevision({ status: "EFFECTIVE" }));

    await expect(
      attachDocumentRevisionFile({
        organizationId: "org-a",
        documentId: "doc-1",
        revisionId: "rev-1",
        actorId: "quality-1",
        fileName: "instruction.txt",
        data: bytes,
        adapter,
      }),
    ).rejects.toMatchObject({ code: "REVISION_IMMUTABLE" });
    expect(adapter.files.size).toBe(0);
    expect(mocks.revisionUpdate).not.toHaveBeenCalled();
  });

  it("deletes the prior stored object after a successful DRAFT replacement", async () => {
    const adapter = new MemoryStorage();
    adapter.files.set("documents/org-a/doc-1/rev-1/old", new Uint8Array([1, 2, 3]));
    mocks.revisionFindFirst.mockResolvedValue(
      draftRevision({
        storageKey: "documents/org-a/doc-1/rev-1/old",
        fileName: "old.txt",
        checksum: "old",
      }),
    );

    await attachDocumentRevisionFile({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-1",
      actorId: "quality-1",
      fileName: "instruction.txt",
      data: bytes,
      adapter,
    });

    expect(adapter.deleted).toContain("documents/org-a/doc-1/rev-1/old");
    expect(adapter.files.has("documents/org-a/doc-1/rev-1/old")).toBe(false);
  });

  it("verifies SHA-256 before returning a stored controlled file", async () => {
    const adapter = new MemoryStorage();
    const key = `documents/org-a/doc-1/rev-1/${checksum}`;
    adapter.files.set(key, bytes);
    mocks.revisionFindFirst.mockResolvedValue({
      id: "rev-1",
      storageKey: key,
      fileName: "instruction.txt",
      mimeType: "text/plain",
      checksum,
    });

    const result = await readDocumentRevisionFile({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-1",
      adapter,
    });

    expect(result.data).toEqual(bytes);
    expect(result.checksum).toBe(checksum);
  });

  it("rejects a stored file whose bytes no longer match the recorded checksum", async () => {
    const adapter = new MemoryStorage();
    const key = `documents/org-a/doc-1/rev-1/${checksum}`;
    adapter.files.set(key, new TextEncoder().encode("tampered content"));
    mocks.revisionFindFirst.mockResolvedValue({
      id: "rev-1",
      storageKey: key,
      fileName: "instruction.txt",
      mimeType: "text/plain",
      checksum,
    });

    await expect(
      readDocumentRevisionFile({
        organizationId: "org-a",
        documentId: "doc-1",
        revisionId: "rev-1",
        adapter,
      }),
    ).rejects.toMatchObject({ code: "FILE_INTEGRITY_FAILED" });
  });
});
