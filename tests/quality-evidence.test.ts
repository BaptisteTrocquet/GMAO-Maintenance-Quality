import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "@/lib/storage";

const mocks = vi.hoisted(() => ({
  getQualityEvent: vi.fn(),
  transaction: vi.fn(),
  auditCreate: vi.fn(),
  auditFindMany: vi.fn(),
  storagePut: vi.fn(),
  storageGet: vi.fn(),
  storageDelete: vi.fn(),
}));

const tx = {
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/quality/events", () => ({ getQualityEvent: mocks.getQualityEvent }));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    auditLog: { findMany: mocks.auditFindMany },
  },
}));

import { addQualityEvidence, listQualityEvidence } from "@/lib/quality/evidence";

const adapter: StorageAdapter = {
  put: mocks.storagePut,
  get: mocks.storageGet,
  delete: mocks.storageDelete,
};

const activeEvent = {
  id: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  status: "INVESTIGATING",
};

const fileData = new Uint8Array([1, 2, 3, 4]);
const baseInput = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  phase: "ROOT_CAUSE" as const,
  kind: "DOCUMENT" as const,
  fileName: "synthetic-analysis.pdf",
  mimeType: "application/pdf",
  description: "Synthetic RCA evidence",
  actorId: "quality-1",
  data: fileData,
  adapter,
};

describe("quality evidence attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQualityEvent.mockResolvedValue(activeEvent);
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.storagePut.mockResolvedValue("stored");
    mocks.storageGet.mockResolvedValue(fileData);
    mocks.storageDelete.mockResolvedValue(undefined);
  });

  it("stores bytes, checksums them and appends immutable evidence plus event audit", async () => {
    const evidence = await addQualityEvidence(baseInput);

    expect(evidence).toMatchObject({
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      phase: "ROOT_CAUSE",
      kind: "DOCUMENT",
      fileName: "synthetic-analysis.pdf",
      sizeBytes: fileData.byteLength,
      createdById: "quality-1",
    });
    expect(evidence.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.storageKey).toContain(`quality-evidence/org-a/event-1/${evidence.id}/`);
    expect(mocks.storagePut).toHaveBeenCalledWith(evidence.storageKey, fileData);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        actorId: "quality-1",
        entityType: "QualityEvidenceAttachment",
        action: "EVIDENCE_ATTACHED",
        afterJson: expect.stringContaining(`"checksum":"${evidence.checksum}"`),
      }),
    });
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        actorId: "quality-1",
        entityType: "QualityEvent",
        entityId: "event-1",
        action: "EVIDENCE_ATTACHED",
      }),
    });
  });

  it("blocks new evidence after the quality event is closed before storing bytes", async () => {
    mocks.getQualityEvent.mockResolvedValue({ ...activeEvent, status: "CLOSED" });

    await expect(addQualityEvidence(baseInput)).rejects.toMatchObject({ code: "EVENT_CLOSED" });
    expect(mocks.storagePut).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("deletes stored bytes when the audit transaction fails", async () => {
    mocks.transaction.mockRejectedValue(new Error("audit unavailable"));

    await expect(addQualityEvidence(baseInput)).rejects.toThrow("audit unavailable");
    expect(mocks.storagePut).toHaveBeenCalledOnce();
    expect(mocks.storageDelete).toHaveBeenCalledOnce();
    expect(mocks.storageDelete).toHaveBeenCalledWith(expect.stringContaining("quality-evidence/org-a/event-1/"));
  });

  it("uses real JSON quote matching and filters parsed snapshots to the requested tenant/site", async () => {
    const visible = {
      id: "evidence-a",
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      phase: "CAPA",
      kind: "PHOTO",
      fileName: "synthetic-photo.jpg",
      storageKey: "quality-evidence/org-a/event-1/evidence-a/checksum-a",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksum: "a".repeat(64),
      description: null,
      createdById: "quality-2",
      createdAt: "2026-08-08T00:00:00.000Z",
    };
    const wrongTenant = { ...visible, id: "evidence-b", organizationId: "org-b" };
    mocks.auditFindMany.mockResolvedValue([
      { afterJson: JSON.stringify(visible), actor: { displayName: "Synthetic User" } },
      { afterJson: JSON.stringify(wrongTenant), actor: { displayName: "Other Tenant" } },
    ]);

    const evidence = await listQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });

    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "QualityEvidenceAttachment",
        afterJson: {
          contains: '"eventId":"event-1","organizationId":"org-a","siteId":"site-a"',
        },
      },
      include: { actor: { select: { displayName: true } } },
      orderBy: { createdAt: "desc" },
    });
    expect(evidence).toEqual([{ ...visible, actorName: "Synthetic User" }]);
  });

  it("returns null without querying evidence when the quality event is outside scope", async () => {
    mocks.getQualityEvent.mockResolvedValue(null);

    const result = await listQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-missing",
    });

    expect(result).toBeNull();
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
  });
});
