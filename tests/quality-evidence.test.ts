import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getQualityEvent: vi.fn(),
  auditCreate: vi.fn(),
  auditFindMany: vi.fn(),
  auditFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      create: mocks.auditCreate,
      findMany: mocks.auditFindMany,
      findFirst: mocks.auditFindFirst,
    },
  },
}));
vi.mock("@/lib/quality/events", () => ({ getQualityEvent: mocks.getQualityEvent }));

import {
  attachQualityEvidence,
  listQualityEvidence,
  readQualityEvidence,
} from "@/lib/quality/evidence";

function adapter() {
  return {
    put: vi.fn(async (key: string) => key),
    get: vi.fn<() => Promise<Uint8Array>>(),
    delete: vi.fn(async () => undefined),
  };
}

describe("quality evidence attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQualityEvent.mockResolvedValue({ id: "event-1", status: "INVESTIGATING" });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditFindFirst.mockResolvedValue(null);
  });

  it("stores immutable evidence metadata with SHA-256 audit data", async () => {
    const store = adapter();
    const data = new TextEncoder().encode("synthetic evidence");

    const evidence = await attachQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
      fileName: "inspection.txt",
      mimeType: "text/plain",
      kind: "INSPECTION",
      description: "Synthetic verification evidence",
      data,
      adapter: store,
    });

    expect(evidence.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.storageKey).toContain(`quality-evidence/org-a/event-1/${evidence.id}/`);
    expect(store.put).toHaveBeenCalledWith(evidence.storageKey, data);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "quality-1",
        entityType: "QualityEvidenceAttachment",
        entityId: evidence.id,
        action: "EVIDENCE_ATTACHED",
        afterJson: expect.stringContaining('"organizationId":"org-a"'),
      }),
    });
  });

  it("removes stored bytes if audit persistence fails", async () => {
    const store = adapter();
    mocks.auditCreate.mockRejectedValue(new Error("audit unavailable"));

    await expect(
      attachQualityEvidence({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
        fileName: "evidence.txt",
        data: new TextEncoder().encode("synthetic"),
        adapter: store,
      }),
    ).rejects.toThrow("audit unavailable");

    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it("does not allow new evidence after event closure", async () => {
    const store = adapter();
    mocks.getQualityEvent.mockResolvedValue({ id: "event-1", status: "CLOSED" });

    await expect(
      attachQualityEvidence({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
        fileName: "late.txt",
        data: new Uint8Array([1]),
        adapter: store,
      }),
    ).rejects.toMatchObject({ code: "EVENT_CLOSED" });

    expect(store.put).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("lists only parsed evidence in the requested tenant/site/event scope", async () => {
    mocks.auditFindMany.mockResolvedValue([
      {
        afterJson: JSON.stringify({
          id: "evidence-1",
          eventId: "event-1",
          organizationId: "org-a",
          siteId: "site-a",
          fileName: "proof.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          checksumSha256: "a".repeat(64),
          storageKey: "quality-evidence/org-a/event-1/evidence-1/checksum",
          kind: "EVIDENCE",
          description: null,
          uploadedById: "quality-1",
          createdAt: "2026-08-08T00:00:00.000Z",
        }),
        actor: { displayName: "Synthetic Quality User" },
      },
      {
        afterJson: JSON.stringify({
          id: "other",
          eventId: "event-other",
          organizationId: "org-a",
          siteId: "site-a",
          fileName: "other.txt",
          mimeType: null,
          sizeBytes: 1,
          checksumSha256: "b".repeat(64),
          storageKey: "quality-evidence/org-a/event-other/other/checksum",
          kind: "EVIDENCE",
          description: null,
          uploadedById: "quality-1",
          createdAt: "2026-08-08T00:00:00.000Z",
        }),
        actor: null,
      },
    ]);

    const evidence = await listQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ id: "evidence-1", uploaderName: "Synthetic Quality User" });
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "QualityEvidenceAttachment",
          AND: expect.arrayContaining([
            { afterJson: { contains: '"organizationId":"org-a"' } },
            { afterJson: { contains: '"siteId":"site-a"' } },
            { afterJson: { contains: '"eventId":"event-1"' } },
          ]),
        }),
      }),
    );
  });

  it("rejects evidence when stored bytes fail the recorded checksum", async () => {
    const store = adapter();
    store.get.mockResolvedValue(new TextEncoder().encode("tampered"));
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify({
        id: "evidence-1",
        eventId: "event-1",
        organizationId: "org-a",
        siteId: "site-a",
        fileName: "proof.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        checksumSha256: "a".repeat(64),
        storageKey: "quality-evidence/org-a/event-1/evidence-1/checksum",
        kind: "EVIDENCE",
        description: null,
        uploadedById: "quality-1",
        createdAt: "2026-08-08T00:00:00.000Z",
      }),
    });

    await expect(
      readQualityEvidence({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        evidenceId: "evidence-1",
        adapter: store,
      }),
    ).rejects.toMatchObject({ code: "FILE_INTEGRITY_FAILED" });
  });
});
