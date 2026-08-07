import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  documentFindFirst: vi.fn(),
  revisionFindFirst: vi.fn(),
  revisionFindMany: vi.fn(),
  revisionUpdate: vi.fn(),
  revisionUpdateMany: vi.fn(),
  approvalDeleteMany: vi.fn(),
  approvalCreateMany: vi.fn(),
  approvalUpdate: vi.fn(),
  approvalCount: vi.fn(),
  membershipFindMany: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    document: { findFirst: mocks.documentFindFirst },
    documentRevision: {
      findFirst: mocks.revisionFindFirst,
      findMany: mocks.revisionFindMany,
      update: mocks.revisionUpdate,
      updateMany: mocks.revisionUpdateMany,
    },
    documentApproval: {
      deleteMany: mocks.approvalDeleteMany,
      createMany: mocks.approvalCreateMany,
      update: mocks.approvalUpdate,
      count: mocks.approvalCount,
    },
    organizationMembership: { findMany: mocks.membershipFindMany },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

import {
  activateRevision,
  decideRevisionApproval,
  requestRevisionApproval,
  resolveEffectiveRevision,
  submitRevisionForReview,
} from "@/lib/documents/workflow";

function revision(overrides: Record<string, unknown> = {}) {
  return {
    id: "rev-b",
    documentId: "doc-1",
    revision: "B",
    status: "DRAFT",
    effectiveAt: null,
    storageKey: "documents/org-a/doc-1/rev-b/abc",
    checksum: "abc",
    fileName: "instruction.pdf",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    document: { id: "doc-1", code: "WI-001", title: "Inspection instruction" },
    approvals: [],
    ...overrides,
  };
}

describe("controlled document workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        documentApproval: {
          deleteMany: mocks.approvalDeleteMany,
          createMany: mocks.approvalCreateMany,
        },
        documentRevision: {
          updateMany: mocks.revisionUpdateMany,
          update: mocks.revisionUpdate,
        },
      }),
    );
  });

  it("requires a controlled file before a DRAFT revision can enter review", async () => {
    mocks.revisionFindFirst.mockResolvedValue(revision({ storageKey: null, checksum: null }));

    await expect(
      submitRevisionForReview({
        organizationId: "org-a",
        documentId: "doc-1",
        revisionId: "rev-b",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "REVISION_FILE_REQUIRED" });
    expect(mocks.revisionUpdate).not.toHaveBeenCalled();
  });

  it("submits a complete DRAFT revision for review and audits the transition", async () => {
    mocks.revisionFindFirst.mockResolvedValue(revision());
    mocks.revisionUpdate.mockResolvedValue(revision({ status: "IN_REVIEW" }));

    const result = await submitRevisionForReview({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-b",
      actorId: "quality-1",
    });

    expect(result.status).toBe("IN_REVIEW");
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "SUBMITTED_FOR_REVIEW", actorId: "quality-1" }),
    });
  });

  it("rejects approval routing to users without document approval permission", async () => {
    mocks.revisionFindFirst.mockResolvedValue(revision({ status: "IN_REVIEW" }));
    mocks.membershipFindMany.mockResolvedValue([{ userId: "tech-1", role: "TECHNICIAN" }]);

    await expect(
      requestRevisionApproval({
        organizationId: "org-a",
        documentId: "doc-1",
        revisionId: "rev-b",
        approverIds: ["tech-1"],
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "APPROVER_NOT_ELIGIBLE" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("routes approval only to eligible active organization approvers", async () => {
    mocks.revisionFindFirst
      .mockResolvedValueOnce(revision({ status: "IN_REVIEW" }))
      .mockResolvedValueOnce(
        revision({
          status: "IN_REVIEW",
          approvals: [{ id: "approval-1", approverId: "quality-2", decision: "PENDING" }],
        }),
      );
    mocks.membershipFindMany.mockResolvedValue([{ userId: "quality-2", role: "QUALITY_MANAGER" }]);

    const result = await requestRevisionApproval({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-b",
      approverIds: ["quality-2", "quality-2"],
      actorId: "quality-1",
    });

    expect(result.approvals).toHaveLength(1);
    expect(mocks.approvalCreateMany).toHaveBeenCalledWith({
      data: [{ documentRevisionId: "rev-b", approverId: "quality-2", decision: "PENDING" }],
    });
  });

  it("marks the revision APPROVED when the final assigned approver approves", async () => {
    mocks.revisionFindFirst.mockResolvedValue(
      revision({
        status: "IN_REVIEW",
        approvals: [{ id: "approval-1", approverId: "quality-2", decision: "PENDING" }],
      }),
    );
    mocks.approvalUpdate.mockResolvedValue({
      id: "approval-1",
      approverId: "quality-2",
      decision: "APPROVED",
      decidedAt: new Date(),
    });
    mocks.approvalCount.mockResolvedValue(0);
    mocks.revisionUpdate.mockResolvedValue(revision({ status: "APPROVED" }));

    const result = await decideRevisionApproval({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-b",
      actorId: "quality-2",
      decision: "APPROVED",
    });

    expect(result.status).toBe("APPROVED");
    expect(mocks.revisionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "APPROVED" } }),
    );
  });

  it("returns a rejected revision to DRAFT for correction", async () => {
    mocks.revisionFindFirst.mockResolvedValue(
      revision({
        status: "IN_REVIEW",
        approvals: [{ id: "approval-1", approverId: "quality-2", decision: "PENDING" }],
      }),
    );
    mocks.approvalUpdate.mockResolvedValue({ id: "approval-1", decision: "REJECTED" });
    mocks.revisionUpdate.mockResolvedValue(revision({ status: "DRAFT" }));

    const result = await decideRevisionApproval({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-b",
      actorId: "quality-2",
      decision: "REJECTED",
      comment: "Update the safety step",
    });

    expect(result.status).toBe("DRAFT");
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "RETURNED_TO_DRAFT" }),
    });
  });

  it("activates a due approved revision and supersedes the previous effective revision", async () => {
    const effectiveAt = new Date("2026-08-07T08:00:00.000Z");
    mocks.revisionFindFirst
      .mockResolvedValueOnce(revision({ status: "APPROVED", effectiveAt }))
      .mockResolvedValueOnce(revision({ status: "EFFECTIVE", effectiveAt }));
    mocks.revisionFindMany.mockResolvedValue([{ id: "rev-a", revision: "A" }]);

    const result = await activateRevision({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-b",
      actorId: "quality-1",
      asOf: new Date("2026-08-07T09:00:00.000Z"),
    });

    expect(result.status).toBe("EFFECTIVE");
    expect(mocks.revisionUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["rev-a"] } },
      data: { status: "OBSOLETE" },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "REVISION_SUPERSEDED", entityId: "rev-a" }),
    });
  });

  it("resolves the revision effective at an arbitrary as-of date", async () => {
    const expected = revision({ status: "APPROVED", effectiveAt: new Date("2026-09-01T00:00:00.000Z") });
    mocks.documentFindFirst.mockResolvedValue({ id: "doc-1" });
    mocks.revisionFindFirst.mockResolvedValue(expected);

    const asOf = new Date("2026-09-15T00:00:00.000Z");
    const result = await resolveEffectiveRevision({ organizationId: "org-a", documentId: "doc-1", asOf });

    expect(result).toEqual(expected);
    expect(mocks.revisionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          documentId: "doc-1",
          status: { in: ["APPROVED", "EFFECTIVE"] },
          effectiveAt: { lte: asOf },
        }),
      }),
    );
  });
});
