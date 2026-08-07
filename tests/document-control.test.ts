import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  documentFindFirst: vi.fn(),
  documentUpdate: vi.fn(),
  revisionCreate: vi.fn(),
  revisionFindFirst: vi.fn(),
  revisionUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    document: {
      findFirst: mocks.documentFindFirst,
      update: mocks.documentUpdate,
    },
    documentRevision: {
      create: mocks.revisionCreate,
      findFirst: mocks.revisionFindFirst,
      update: mocks.revisionUpdate,
    },
    auditLog: { create: mocks.auditCreate },
  },
}));

import {
  createDocumentRevision,
  updateDocumentMaster,
  updateDraftDocumentRevision,
} from "@/lib/documents/control";

describe("controlled document domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.documentFindFirst.mockResolvedValue({
      id: "doc-1",
      organizationId: "org-a",
      code: "WI-001",
      title: "Inspection instruction",
      type: "WORK_INSTRUCTION",
      owner: "Maintenance",
      description: null,
    });
    mocks.documentUpdate.mockResolvedValue({
      id: "doc-1",
      organizationId: "org-a",
      code: "WI-001",
      title: "Updated inspection instruction",
      type: "WORK_INSTRUCTION",
      owner: "Reliability",
      description: null,
    });
    mocks.revisionCreate.mockResolvedValue({
      id: "rev-1",
      documentId: "doc-1",
      revision: "B",
      status: "DRAFT",
      changeSummary: "Clarify inspection sequence",
      createdBy: "quality-1",
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("updates document master metadata and audits before/after values", async () => {
    const result = await updateDocumentMaster({
      organizationId: "org-a",
      documentId: "doc-1",
      actorId: "quality-1",
      title: "Updated inspection instruction",
      owner: "Reliability",
    });

    expect(result.title).toBe("Updated inspection instruction");
    expect(mocks.documentUpdate).toHaveBeenCalledWith({
      where: { id: "doc-1" },
      data: { title: "Updated inspection instruction", owner: "Reliability" },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "quality-1",
        entityType: "Document",
        entityId: "doc-1",
        action: "UPDATED",
        beforeJson: expect.any(String),
        afterJson: expect.any(String),
      }),
    });
  });

  it("creates every new revision as DRAFT with creator and audit history", async () => {
    const result = await createDocumentRevision({
      organizationId: "org-a",
      documentId: "doc-1",
      revision: "B",
      changeSummary: "Clarify inspection sequence",
      actorId: "quality-1",
    });

    expect(result.status).toBe("DRAFT");
    expect(mocks.revisionCreate).toHaveBeenCalledWith({
      data: {
        documentId: "doc-1",
        revision: "B",
        status: "DRAFT",
        changeSummary: "Clarify inspection sequence",
        createdBy: "quality-1",
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "DocumentRevision",
        entityId: "rev-1",
        action: "CREATED",
      }),
    });
  });

  it("allows revision metadata edits while DRAFT", async () => {
    mocks.revisionFindFirst.mockResolvedValue({
      id: "rev-1",
      documentId: "doc-1",
      revision: "B",
      status: "DRAFT",
      changeSummary: null,
    });
    mocks.revisionUpdate.mockResolvedValue({
      id: "rev-1",
      documentId: "doc-1",
      revision: "B",
      status: "DRAFT",
      changeSummary: "Updated summary",
    });

    const result = await updateDraftDocumentRevision({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-1",
      actorId: "quality-1",
      changeSummary: "Updated summary",
    });

    expect(result.changeSummary).toBe("Updated summary");
    expect(mocks.revisionUpdate).toHaveBeenCalledWith({
      where: { id: "rev-1" },
      data: { changeSummary: "Updated summary" },
    });
  });

  it("rejects metadata changes once a revision leaves DRAFT", async () => {
    mocks.revisionFindFirst.mockResolvedValue({
      id: "rev-effective",
      documentId: "doc-1",
      revision: "A",
      status: "EFFECTIVE",
      changeSummary: "Released revision",
    });

    await expect(
      updateDraftDocumentRevision({
        organizationId: "org-a",
        documentId: "doc-1",
        revisionId: "rev-effective",
        actorId: "quality-1",
        changeSummary: "Should not change",
      }),
    ).rejects.toMatchObject({ code: "REVISION_IMMUTABLE" });
    expect(mocks.revisionUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
