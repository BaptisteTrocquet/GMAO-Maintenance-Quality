import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getQualityEvent: vi.fn(),
  auditCreate: vi.fn(),
  auditFindMany: vi.fn(),
  auditFindFirst: vi.fn(),
}));

vi.mock("@/lib/quality/events", () => ({ getQualityEvent: mocks.getQualityEvent }));
vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      create: mocks.auditCreate,
      findMany: mocks.auditFindMany,
      findFirst: mocks.auditFindFirst,
    },
  },
}));

import {
  attachQualityEvidence,
  listQualityEvidence,
  readQualityEvidence,
} from "@/lib/quality/evidence";

const adapter = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

const input = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  actorId: "quality-1",
  fileName: "synthetic-evidence.txt",
  mimeType: "text/plain",
  kind: "INSPECTION",
  description: "Synthetic verification evidence",
  data: new TextEncoder().encode("synthetic evidence payload"),
  adapter,
};

describe("quality evidence attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQualityEvent.mockResolvedValue({
      id: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      status: "INVESTIGATING",
    });
    adapter.put.mockImplementation(async (key: string) => key);
    adapter.delete.mockResolvedValue(undefined);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("stores immutable evidence bytes and audits checksum metadata", async () => {
    const result = await attachQualityEvidence(input);

    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.storageKey).toContain(`quality-evidence/org-a/event-1/${result.id}/`);
    expect(adapter.put).toHaveBeenCalledWith(result.storageKey, input.data);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "quality-1",
        entityType: "QualityEvidenceAttachment",
        entityId: result.id,
        action: "EVIDENCE_ATTACHED",
        afterJson: expect.stringContaining('"checksum":"'),
      }),
    });
  });

  it("rejects evidence mutation after the quality event is closed", async () => {
    mocks.getQualityEvent.mockResolvedValue({
      organizationId: "org-a",
      siteId: "site-a",
      status: "CLOSED",
    });

    await expect(attachQualityEvidence(input)).rejects.toMatchObject({ code: "EVENT_CLOSED" });
    expect(adapter.put).not.toHaveBeenCalled();
  });

  it("removes stored bytes if the immutable audit reference cannot be recorded", async () => {
    mocks.auditCreate.mockRejectedValue(new Error("database unavailable"));

    await expect(attachQualityEvidence(input)).rejects.toThrow("database unavailable");
    const storageKey = adapter.put.mock.calls[0]?.[0];
    expect(storageKey).toBeTruthy();
    expect(adapter.delete).toHaveBeenCalledWith(storageKey);
  });

  it("scopes evidence search with independent compact JSON markers", async () => {
    mocks.auditFindMany.mockResolvedValue([]);

    await listQualityEvidence({ organizationId: "org-a", siteId: "site-a", eventId: "event-1" });

    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "QualityEvidenceAttachment",
        AND: [
          { afterJson: { contains: '"organizationId":"org-a"' } },
          { afterJson: { contains: '"siteId":"site-a"' } },
          { afterJson: { contains: '"eventId":"event-1"' } },
        ],
      },
      include: { actor: { select: { displayName: true } } },
      orderBy: { createdAt: "desc" },
    });
  });

  it("filters any false-positive audit rows after parsing snapshots", async () => {
    mocks.auditFindMany.mockResolvedValue([
      {
        afterJson: JSON.stringify({
          id: "evidence-other",
          eventId: "event-other",
          organizationId: "org-a",
          siteId: "site-a",
          fileName: "other.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          checksum: "a".repeat(64),
          storageKey: "quality-evidence/org-a/event-other/evidence-other/checksum",
          kind: "EVIDENCE",
          description: null,
          uploadedById: "quality-1",
          createdAt: "2026-08-08T00:00:00.000Z",
        }),
        actor: { displayName: "Synthetic User" },
      },
    ]);

    const result = await listQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
    expect(result).toEqual([]);
  });

  it("verifies SHA-256 before returning stored evidence", async () => {
    const created = await attachQualityEvidence(input);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(created) });
    adapter.get.mockResolvedValue(input.data);

    const result = await readQualityEvidence({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      evidenceId: created.id,
      adapter,
    });
    expect(new TextDecoder().decode(result.data)).toBe("synthetic evidence payload");

    adapter.get.mockResolvedValue(new TextEncoder().encode("tampered"));
    await expect(
      readQualityEvidence({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        evidenceId: created.id,
        adapter,
      }),
    ).rejects.toMatchObject({ code: "FILE_INTEGRITY_FAILED" });
  });
});
