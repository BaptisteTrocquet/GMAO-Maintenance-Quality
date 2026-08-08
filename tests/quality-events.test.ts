import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  siteFindFirst: vi.fn(),
  membershipFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  workOrderFindFirst: vi.fn(),
  documentFindMany: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
  site: { findFirst: mocks.siteFindFirst },
  organizationMembership: { findFirst: mocks.membershipFindFirst },
  asset: { findFirst: mocks.assetFindFirst },
  workOrder: { findFirst: mocks.workOrderFindFirst },
  document: { findMany: mocks.documentFindMany },
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
  createQualityEvent,
  getQualityEvent,
  listQualityEvents,
  setImmediateContainment,
  transitionQualityEvent,
} from "@/lib/quality/events";

const createInput = {
  organizationId: "org-a",
  siteId: "site-a",
  eventKey: "synthetic-qe-2026-08-08-001",
  type: "NONCONFORMITY" as const,
  severity: "HIGH" as const,
  title: "Synthetic dimensional nonconformity",
  description: "Synthetic quality event used for automated tests.",
  occurredAt: new Date("2026-08-08T00:00:00.000Z"),
  assetId: "asset-1",
  workOrderId: "wo-1",
  documentIds: ["doc-1"],
  actorId: "quality-1",
};

describe("quality event workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.membershipFindFirst.mockResolvedValue({ id: "membership-1" });
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-1", code: "AST-001", name: "Synthetic asset" });
    mocks.workOrderFindFirst.mockResolvedValue({ id: "wo-1", number: "WO-001", title: "Synthetic work order" });
    mocks.documentFindMany.mockResolvedValue([{ id: "doc-1", code: "WI-001", title: "Synthetic work instruction" }]);
  });

  it("creates an idempotent quality event with frozen linked master-data labels", async () => {
    const first = await createQualityEvent(createInput);

    expect(first.idempotent).toBe(false);
    expect(first.qualityEvent).toMatchObject({
      organizationId: "org-a",
      siteId: "site-a",
      status: "OPEN",
      asset: { id: "asset-1", code: "AST-001", name: "Synthetic asset" },
      workOrder: { id: "wo-1", number: "WO-001", title: "Synthetic work order" },
      documents: [{ id: "doc-1", code: "WI-001", title: "Synthetic work instruction" }],
    });

    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(first.qualityEvent) });
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-1", code: "RENAMED", name: "Renamed master asset" });
    mocks.workOrderFindFirst.mockResolvedValue({ id: "wo-1", number: "WO-999", title: "Renamed master WO" });
    mocks.documentFindMany.mockResolvedValue([{ id: "doc-1", code: "WI-999", title: "Renamed master document" }]);

    const stored = await getQualityEvent({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: first.qualityEvent.id,
    });
    expect(stored?.asset?.code).toBe("AST-001");
    expect(stored?.workOrder?.number).toBe("WO-001");
    expect(stored?.documents[0]?.code).toBe("WI-001");

    const retry = await createQualityEvent(createInput);
    expect(retry.idempotent).toBe(true);
    expect(retry.qualityEvent.id).toBe(first.qualityEvent.id);
  });

  it("rejects linked assets outside the selected site", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(createQualityEvent(createInput)).rejects.toMatchObject({
      code: "ASSET_NOT_FOUND",
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("records immediate containment only with an active organization member", async () => {
    const created = await createQualityEvent(createInput);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(created.qualityEvent) });
    mocks.auditCreate.mockClear();

    const contained = await setImmediateContainment({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: created.qualityEvent.id,
      summary: "Segregate synthetic affected material and block release.",
      ownerId: "quality-2",
      dueAt: new Date("2026-08-09T12:00:00.000Z"),
      actorId: "quality-1",
    });

    expect(contained.status).toBe("CONTAINED");
    expect(contained.containment).toMatchObject({
      ownerId: "quality-2",
      summary: "Segregate synthetic affected material and block release.",
    });
    expect(mocks.membershipFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-a", userId: "quality-2", active: true }),
      }),
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CONTAINMENT_RECORDED" }),
    });
  });

  it("rejects containment ownership outside active organization membership", async () => {
    const created = await createQualityEvent(createInput);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(created.qualityEvent) });
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(
      setImmediateContainment({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: created.qualityEvent.id,
        summary: "Synthetic containment",
        ownerId: "user-other-org",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "CONTAINMENT_OWNER_NOT_FOUND" });
  });

  it("requires containment and a resolution before closure", async () => {
    const created = await createQualityEvent(createInput);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(created.qualityEvent) });

    await expect(
      transitionQualityEvent({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: created.qualityEvent.id,
        action: "CLOSE",
        resolutionSummary: "Synthetic resolution",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION" });

    const contained = await setImmediateContainment({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: created.qualityEvent.id,
      summary: "Synthetic containment",
      actorId: "quality-1",
    });
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(contained) });

    await expect(
      transitionQualityEvent({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: contained.id,
        action: "CLOSE",
        resolutionSummary: " ",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "RESOLUTION_REQUIRED" });
  });

  it("moves contained events through investigation to closure with full audit snapshots", async () => {
    const created = await createQualityEvent(createInput);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(created.qualityEvent) });
    const contained = await setImmediateContainment({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: created.qualityEvent.id,
      summary: "Synthetic containment",
      completedAt: new Date("2026-08-08T01:00:00.000Z"),
      actorId: "quality-1",
    });

    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(contained) });
    const investigating = await transitionQualityEvent({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: contained.id,
      action: "START_INVESTIGATION",
      actorId: "quality-1",
    });
    expect(investigating.status).toBe("INVESTIGATING");

    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(investigating) });
    const closed = await transitionQualityEvent({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: investigating.id,
      action: "CLOSE",
      resolutionSummary: "Synthetic root issue corrected and verified.",
      actorId: "quality-1",
    });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedAt).toBeTruthy();
    expect(closed.resolutionSummary).toContain("corrected");
  });

  it("uses the exact JSON tenant/site marker when listing quality events", async () => {
    const created = await createQualityEvent(createInput);
    mocks.auditFindMany.mockResolvedValue([
      { entityId: created.qualityEvent.id, afterJson: JSON.stringify(created.qualityEvent) },
    ]);

    const events = await listQualityEvents({ organizationId: "org-a", siteId: "site-a" });

    expect(events).toHaveLength(1);
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityType: "QualityEvent",
          afterJson: { contains: '"organizationId":"org-a","siteId":"site-a"' },
        },
      }),
    );
  });
});
