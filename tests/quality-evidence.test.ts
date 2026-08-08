import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getQualityEvent: vi.fn(),
  transaction: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/quality/events", () => ({ getQualityEvent: mocks.getQualityEvent }));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    auditLog: { findMany: mocks.auditFindMany, create: mocks.auditCreate },
  },
}));
vi.mock("@/lib/storage", () => ({
  storage: {},
}));

import {
  addQualityEvidence,
  listQualityEvidence,
  QualityEvidenceError,
  readQualityEvidence,
  removeQualityEvidence,
} from "@/lib/quality/evidence";
import type { StorageAdapter } from "@/lib/storage";

function memoryStorage() {
  const files = new Map<string, Uint8Array>();
  const adapter: StorageAdapter = {
    put: vi.fn(async (key, data) => files.set(key, new Uint8Array(data))),
    get: vi.fn(async (key) => {
      const value = files.get(key);
      if (!value) throw new Error("not found");
      return new Uint8Array(value);
    }),
    delete: vi.fn(async (key) => {
      files.delete(key);
    }),
    exists: vi.fn(async (key) => files.has(key)),
  };
  return { adapter, files };
}

function openEvent(status = "INVESTIGATING") {
  return { id: "event-1", status };
}

describe("quality evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQualityEvent.mockResolvedValue(openEvent());
    mocks.transaction.mockImplementation(async (callback: (tx: { auditLog: { create: typeof mocks.auditCreate } }) => Promise<unknown>) =>
      callback({ auditLog: { create: mocks.auditCreate } }),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
  });

  it("stores evidence with SHA-256 metadata and two audit events", async () => {
    const { adapter } = memoryStorage();
    const data = new TextEncoder().encode("synthetic inspection evidence");

    const evidence = await addQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      phase: "ROOT_CAUSE",
      kind: "DOCUMENT",
      fileName: "synthetic-evidence.txt",
      mimeType: "text/plain",
      description: "Synthetic test record",
      actorId: "quality-1",
      data,
      adapter,
    });

    expect(evidence.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.storageKey).toContain(evidence.checksum);
    expect(adapter.put).toHaveBeenCalledWith(evidence.storageKey, data);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "QualityEvidenceAttachment",
        entityId: evidence.id,
        action: "EVIDENCE_ATTACHED",
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "QualityEvent",
        entityId: "event-1",
        action: "EVIDENCE_ATTACHED",
      }),
    });
  });

  it("removes the stored blob when audit persistence fails during attach", async () => {
    const { adapter } = memoryStorage();
    mocks.transaction.mockRejectedValue(new Error("audit unavailable"));

    await expect(
      addQualityEvidence({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        phase: "EVENT",
        kind: "RECORD",
        fileName: "synthetic.txt",
        actorId: "quality-1",
        data: new TextEncoder().encode("synthetic"),
        adapter,
      }),
    ).rejects.toThrow("audit unavailable");

    expect(adapter.delete).toHaveBeenCalledTimes(1);
  });

  it("detects stored-file tampering before download", async () => {
    const { adapter, files } = memoryStorage();
    const evidence = await addQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      phase: "CAPA",
      kind: "RECORD",
      fileName: "verification.txt",
      actorId: "quality-1",
      data: new TextEncoder().encode("original"),
      adapter,
    });
    mocks.auditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(evidence) }]);
    files.set(evidence.storageKey, new TextEncoder().encode("tampered"));

    await expect(
      readQualityEvidence({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        evidenceId: evidence.id,
        adapter,
      }),
    ).rejects.toMatchObject({ code: "FILE_INTEGRITY_FAILED" });
  });

  it("soft-removes the registry entry, audits removal and deletes the active blob", async () => {
    const { adapter } = memoryStorage();
    const evidence = await addQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      phase: "EFFECTIVENESS",
      kind: "DOCUMENT",
      fileName: "effectiveness.txt",
      actorId: "quality-1",
      data: new TextEncoder().encode("objective evidence"),
      adapter,
    });
    mocks.auditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(evidence) }]);
    mocks.auditCreate.mockClear();

    const result = await removeQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      evidenceId: evidence.id,
      actorId: "quality-2",
      adapter,
    });

    expect(result.evidence.removedAt).toBeTruthy();
    expect(result.evidence.removedById).toBe("quality-2");
    expect(result.storageDeleted).toBe(true);
    expect(adapter.delete).toHaveBeenCalledWith(evidence.storageKey);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "QualityEvidenceAttachment",
        action: "EVIDENCE_REMOVED",
      }),
    });
  });

  it("blocks evidence mutations after the quality event is closed", async () => {
    mocks.getQualityEvent.mockResolvedValue(openEvent("CLOSED"));
    const { adapter } = memoryStorage();

    await expect(
      addQualityEvidence({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        phase: "EVENT",
        kind: "DOCUMENT",
        fileName: "closed.txt",
        actorId: "quality-1",
        data: new TextEncoder().encode("closed"),
        adapter,
      }),
    ).rejects.toMatchObject({ code: "EVENT_CLOSED" });
    expect(adapter.put).not.toHaveBeenCalled();
  });

  it("does not expose evidence across a different event or tenant scope", async () => {
    const snapshot = {
      id: "evidence-1",
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      phase: "EVENT",
      kind: "DOCUMENT",
      fileName: "record.txt",
      storageKey: "key",
      mimeType: "text/plain",
      sizeBytes: 5,
      checksum: "a".repeat(64),
      description: null,
      createdById: "quality-1",
      createdAt: "2026-08-08T00:00:00.000Z",
      removedAt: null,
      removedById: null,
    };
    mocks.auditFindMany.mockResolvedValue([
      { afterJson: JSON.stringify(snapshot), actor: { displayName: "Demo Quality" } },
    ]);

    const result = await listQualityEvidence({
      organizationId: "org-b",
      siteId: "site-b",
      eventId: "event-2",
    });

    expect(result).toEqual([]);
  });

  it("uses a typed integrity error", () => {
    const error = new QualityEvidenceError("FILE_INTEGRITY_FAILED", "Checksum mismatch");
    expect(error.code).toBe("FILE_INTEGRITY_FAILED");
  });
});
