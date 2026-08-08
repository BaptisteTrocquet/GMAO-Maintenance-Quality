import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getQualityEvent: vi.fn(),
  auditCreate: vi.fn(),
  auditFindMany: vi.fn(),
}));

vi.mock("@/lib/quality/events", () => ({ getQualityEvent: mocks.getQualityEvent }));
vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      create: mocks.auditCreate,
      findMany: mocks.auditFindMany,
    },
  },
}));

import { addQualityEvidence, listQualityEvidence } from "@/lib/quality/evidence";

const activeEvent = {
  id: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  status: "INVESTIGATING",
};

const baseInput = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  phase: "ROOT_CAUSE" as const,
  kind: "DOCUMENT" as const,
  fileName: "synthetic-analysis.pdf",
  storageKey: "quality/event-1/synthetic-analysis.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  description: "Synthetic RCA evidence",
  actorId: "quality-1",
};

describe("quality evidence attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQualityEvent.mockResolvedValue(activeEvent);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
  });

  it("appends immutable evidence and mirrors a quality-event audit entry", async () => {
    const evidence = await addQualityEvidence(baseInput);

    expect(evidence).toMatchObject({
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      phase: "ROOT_CAUSE",
      kind: "DOCUMENT",
      fileName: "synthetic-analysis.pdf",
      storageKey: "quality/event-1/synthetic-analysis.pdf",
      createdById: "quality-1",
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        actorId: "quality-1",
        entityType: "QualityEvidenceAttachment",
        action: "EVIDENCE_ATTACHED",
        afterJson: expect.stringContaining('"storageKey":"quality/event-1/synthetic-analysis.pdf"'),
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

  it("blocks new evidence after the quality event is closed", async () => {
    mocks.getQualityEvent.mockResolvedValue({ ...activeEvent, status: "CLOSED" });

    await expect(addQualityEvidence(baseInput)).rejects.toMatchObject({ code: "EVENT_CLOSED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("uses a real JSON quote marker and filters parsed snapshots to the requested tenant/site", async () => {
    const visible = {
      id: "evidence-a",
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      phase: "CAPA",
      kind: "PHOTO",
      fileName: "synthetic-photo.jpg",
      storageKey: "quality/event-1/synthetic-photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
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
