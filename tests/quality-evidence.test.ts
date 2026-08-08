import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    auditLog: {
      findFirst: mocks.auditFindFirst,
      findMany: mocks.auditFindMany,
    },
  },
}));

import {
  addQualityEvidence,
  listQualityEvidence,
  MAX_QUALITY_EVIDENCE_BYTES,
  revokeQualityEvidence,
} from "@/lib/quality/evidence";

const event = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "INVESTIGATING",
};

const baseInput = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  category: "ROOT_CAUSE" as const,
  fileName: "synthetic-evidence.pdf",
  storageKey: "quality/event-1/synthetic-evidence.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  note: "Objective evidence supporting the confirmed cause.",
  actorId: "quality-1",
};

describe("quality evidence registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
  });

  it("adds immutable evidence metadata to an active quality event", async () => {
    mocks.auditFindFirst.mockResolvedValueOnce({ afterJson: JSON.stringify(event) });

    const evidence = await addQualityEvidence(baseInput);

    expect(evidence).toMatchObject({
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      category: "ROOT_CAUSE",
      fileName: "synthetic-evidence.pdf",
      active: true,
      uploadedById: "quality-1",
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "QualityEvidence",
        action: "ADDED",
        afterJson: expect.stringContaining('"eventId":"event-1"'),
      }),
    });
  });

  it("rejects evidence changes after the quality event is closed", async () => {
    mocks.auditFindFirst.mockResolvedValueOnce({
      afterJson: JSON.stringify({ ...event, status: "CLOSED" }),
    });

    await expect(addQualityEvidence(baseInput)).rejects.toMatchObject({ code: "EVENT_CLOSED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("enforces MIME and per-file size limits before storage metadata is registered", async () => {
    await expect(
      addQualityEvidence({ ...baseInput, mimeType: "application/x-msdownload" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    await expect(
      addQualityEvidence({ ...baseInput, sizeBytes: MAX_QUALITY_EVIDENCE_BYTES + 1 }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(mocks.auditFindFirst).not.toHaveBeenCalled();
  });

  it("lists only the latest evidence snapshot in the requested tenant/site/event scope", async () => {
    const active = {
      evidenceId: "evidence-1",
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      category: "CAPA_ACTION",
      relatedActionId: "action-1",
      fileName: "implementation.jpg",
      storageKey: "quality/event-1/implementation.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      note: null,
      active: true,
      uploadedById: "quality-1",
      uploadedAt: "2026-08-08T01:00:00.000Z",
      revokedById: null,
      revokedAt: null,
      revokeReason: null,
    };
    const revoked = {
      ...active,
      active: false,
      revokedById: "quality-2",
      revokedAt: "2026-08-08T02:00:00.000Z",
      revokeReason: "Superseded by a clearer photograph.",
    };
    const foreign = { ...active, evidenceId: "foreign", organizationId: "org-b" };

    mocks.auditFindFirst.mockResolvedValueOnce({ afterJson: JSON.stringify(event) });
    mocks.auditFindMany.mockResolvedValue([
      { entityId: "evidence-1", afterJson: JSON.stringify(active) },
      { entityId: "foreign", afterJson: JSON.stringify(foreign) },
      { entityId: "evidence-1", afterJson: JSON.stringify(revoked) },
    ]);

    const activeOnly = await listQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
    expect(activeOnly).toEqual([]);
    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "QualityEvidence",
        afterJson: { contains: '"eventId":"event-1"' },
      },
      orderBy: { createdAt: "asc" },
      select: { entityId: true, afterJson: true },
    });
  });

  it("revokes evidence without deleting or rewriting its original metadata", async () => {
    const existing = {
      evidenceId: "evidence-1",
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      category: "EFFECTIVENESS",
      relatedActionId: null,
      fileName: "verification.pdf",
      storageKey: "quality/event-1/verification.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      note: "Follow-up verification.",
      active: true,
      uploadedById: "quality-1",
      uploadedAt: "2026-08-08T01:00:00.000Z",
      revokedById: null,
      revokedAt: null,
      revokeReason: null,
    };
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(existing) });

    const revoked = await revokeQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      evidenceId: "evidence-1",
      reason: "Uploaded to the wrong evidence category.",
      actorId: "quality-2",
    });

    expect(revoked).toMatchObject({
      fileName: "verification.pdf",
      storageKey: "quality/event-1/verification.pdf",
      active: false,
      revokedById: "quality-2",
      revokeReason: "Uploaded to the wrong evidence category.",
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "QualityEvidence",
        entityId: "evidence-1",
        action: "REVOKED",
        beforeJson: JSON.stringify(existing),
      }),
    });
  });
});
