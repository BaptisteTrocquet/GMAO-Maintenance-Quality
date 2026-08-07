import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  documentFindFirst: vi.fn(),
  revisionFindMany: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  resolveEffectiveRevision: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    document: { findFirst: mocks.documentFindFirst },
    documentRevision: { findMany: mocks.revisionFindMany },
    auditLog: {
      findFirst: mocks.auditFindFirst,
      findMany: mocks.auditFindMany,
      create: mocks.auditCreate,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/documents/workflow", () => ({
  resolveEffectiveRevision: mocks.resolveEffectiveRevision,
}));

import {
  acknowledgeEffectiveRevision,
  getEffectiveRevisionAcknowledgement,
  listDocumentReadAcknowledgements,
} from "@/lib/documents/acknowledgements";

const checksum = "a".repeat(64);

function effectiveRevision() {
  return {
    id: "rev-b",
    documentId: "doc-1",
    revision: "B",
    status: "EFFECTIVE",
    effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
    checksum,
  };
}

describe("document read acknowledgements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.documentFindFirst.mockResolvedValue({
      id: "doc-1",
      code: "WI-001",
      title: "Inspection instruction",
    });
    mocks.resolveEffectiveRevision.mockResolvedValue(effectiveRevision());
    mocks.auditCreate.mockResolvedValue({ id: "audit-ack-1" });
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        auditLog: {
          findFirst: mocks.auditFindFirst,
          create: mocks.auditCreate,
        },
      }),
    );
  });

  it("records an immutable acknowledgement snapshot for the effective revision checksum", async () => {
    mocks.auditFindFirst.mockResolvedValue(null);
    const asOf = new Date("2026-08-07T12:00:00.000Z");
    const now = new Date("2026-08-07T12:01:00.000Z");

    const result = await acknowledgeEffectiveRevision({
      organizationId: "org-a",
      documentId: "doc-1",
      actorId: "viewer-1",
      checksum,
      asOf,
      now,
    });

    expect(result.created).toBe(true);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "viewer-1",
        entityType: "DocumentRevision",
        entityId: "rev-b",
        action: "READ_ACKNOWLEDGED",
        createdAt: now,
        afterJson: expect.stringContaining(checksum),
      }),
    });
  });

  it("is idempotent when the user already acknowledged the same immutable revision", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      id: "audit-existing",
      afterJson: JSON.stringify({ revisionId: "rev-b", checksum }),
      createdAt: new Date("2026-08-06T10:00:00.000Z"),
    });

    const result = await acknowledgeEffectiveRevision({
      organizationId: "org-a",
      documentId: "doc-1",
      actorId: "viewer-1",
      checksum,
    });

    expect(result.created).toBe(false);
    expect(result.auditId).toBe("audit-existing");
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects acknowledgement of bytes that do not match the effective revision checksum", async () => {
    await expect(
      acknowledgeEffectiveRevision({
        organizationId: "org-a",
        documentId: "doc-1",
        actorId: "viewer-1",
        checksum: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("reports self acknowledgement status for the server-resolved effective revision", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      id: "audit-existing",
      afterJson: JSON.stringify({ revisionId: "rev-b", checksum }),
      createdAt: new Date("2026-08-06T10:00:00.000Z"),
    });

    const result = await getEffectiveRevisionAcknowledgement({
      organizationId: "org-a",
      documentId: "doc-1",
      actorId: "viewer-1",
    });

    expect(result.acknowledged).toBe(true);
    expect(result.revision.id).toBe("rev-b");
    expect(mocks.auditFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorId: "viewer-1", entityId: "rev-b", action: "READ_ACKNOWLEDGED" }),
      }),
    );
  });

  it("lists acknowledgement history across revisions for document managers", async () => {
    mocks.revisionFindMany.mockResolvedValue([
      { id: "rev-a", revision: "A", status: "OBSOLETE", effectiveAt: new Date("2026-01-01"), checksum: "1".repeat(64) },
      { id: "rev-b", revision: "B", status: "EFFECTIVE", effectiveAt: new Date("2026-08-01"), checksum },
    ]);
    mocks.auditFindMany.mockResolvedValue([
      {
        id: "audit-ack-1",
        entityId: "rev-b",
        createdAt: new Date("2026-08-07T12:00:00.000Z"),
        afterJson: JSON.stringify({ revisionId: "rev-b", checksum }),
        actor: { id: "viewer-1", displayName: "Demo Viewer", email: "viewer@example.test" },
      },
    ]);

    const result = await listDocumentReadAcknowledgements({
      organizationId: "org-a",
      documentId: "doc-1",
    });

    expect(result.acknowledgements).toHaveLength(1);
    expect(result.acknowledgements[0]?.revision?.revision).toBe("B");
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: "READ_ACKNOWLEDGED", entityId: { in: ["rev-a", "rev-b"] } }),
      }),
    );
  });
});
