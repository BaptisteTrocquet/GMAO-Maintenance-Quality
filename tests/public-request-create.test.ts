import type { PublicMaintenanceRequestToken } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submissionFindUnique: vi.fn(),
  submissionCount: vi.fn(),
  workOrderFindUnique: vi.fn(),
  assetFindFirst: vi.fn(),
  transaction: vi.fn(),
  txSubmissionFindUnique: vi.fn(),
  txWorkOrderFindUnique: vi.fn(),
  txWorkOrderCreate: vi.fn(),
  txSubmissionCreate: vi.fn(),
  txTokenUpdate: vi.fn(),
  txAuditCreate: vi.fn(),
  recordIntegrationEvent: vi.fn(),
}));

const tx = {
  publicMaintenanceRequestSubmission: {
    findUnique: mocks.txSubmissionFindUnique,
    create: mocks.txSubmissionCreate,
  },
  workOrder: {
    findUnique: mocks.txWorkOrderFindUnique,
    create: mocks.txWorkOrderCreate,
  },
  publicMaintenanceRequestToken: { update: mocks.txTokenUpdate },
  auditLog: { create: mocks.txAuditCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    publicMaintenanceRequestSubmission: {
      findUnique: mocks.submissionFindUnique,
      count: mocks.submissionCount,
    },
    workOrder: { findUnique: mocks.workOrderFindUnique },
    asset: { findFirst: mocks.assetFindFirst },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/integrations/event-log", () => ({
  recordIntegrationEventInTransaction: mocks.recordIntegrationEvent,
}));

import { createPublicMaintenanceRequest } from "@/lib/public-requests/create-request";

const token: PublicMaintenanceRequestToken = {
  id: "token-1",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Public requests",
  tokenHash: "hash",
  mode: "PUBLIC",
  allowedOrigins: [],
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  revokedAt: null,
  createdById: "manager-1",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  lastUsedAt: null,
};

const input = {
  token,
  idempotencyKey: "request-0001",
  title: "Machine noise reported",
  description: "Abnormal noise observed during operation.",
  requesterName: "External Requester",
  requesterEmail: "requester@example.local",
  requesterRef: "REF-001",
  origin: null,
  now: new Date("2026-08-07T12:00:00.000Z"),
};

describe("public maintenance request creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.submissionFindUnique.mockResolvedValue(null);
    mocks.submissionCount.mockResolvedValue(0);
    mocks.assetFindFirst.mockResolvedValue(null);
    mocks.txSubmissionFindUnique.mockResolvedValue(null);
    mocks.txWorkOrderCreate.mockResolvedValue({
      id: "wo-1",
      number: "WO-P-DEMO-0001",
      title: "Machine noise reported",
      status: "REQUESTED",
      requestedAt: new Date("2026-08-07T12:00:00.000Z"),
    });
    mocks.txSubmissionCreate.mockResolvedValue({ id: "submission-1" });
    mocks.txTokenUpdate.mockResolvedValue({ id: "token-1" });
    mocks.txAuditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.recordIntegrationEvent.mockResolvedValue({ event: { id: "event-1" }, replayed: false });
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
  });

  it("creates the WO, business audit and outbound event in one transaction", async () => {
    const result = await createPublicMaintenanceRequest(input);

    expect(result.idempotent).toBe(false);
    expect(result.trackingId).toBe("submission-1");
    expect(mocks.txWorkOrderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        siteId: "site-a",
        requesterId: null,
        title: "Machine noise reported",
        type: "CORRECTIVE",
        status: "REQUESTED",
        priority: "NORMAL",
      }),
      select: { id: true, number: true, title: true, status: true, requestedAt: true },
    });
    expect(mocks.txSubmissionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenId: "token-1",
        workOrderId: "wo-1",
        idempotencyKey: "request-0001",
        requesterEmail: "requester@example.local",
      }),
      select: { id: true },
    });
    expect(mocks.txAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: null,
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "PUBLIC_REQUEST_CREATED",
        afterJson: expect.stringContaining("submission-1"),
      }),
    });
    expect(mocks.recordIntegrationEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        direction: "OUTBOUND",
        channel: "webhook",
        eventType: "work_order.created",
        sourceId: "audit-1",
        subjectId: "wo-1",
      }),
    );
  });

  it("returns the same tracking id without a second write on idempotent retry", async () => {
    mocks.submissionFindUnique.mockResolvedValue({
      id: "submission-1",
      tokenId: "token-1",
      workOrderId: "wo-existing",
      idempotencyKey: "request-0001",
    });
    mocks.workOrderFindUnique.mockResolvedValue({
      id: "wo-existing",
      number: "WO-P-EXISTING",
      status: "REQUESTED",
      requestedAt: new Date("2026-08-07T11:00:00.000Z"),
    });

    const result = await createPublicMaintenanceRequest(input);

    expect(result.idempotent).toBe(true);
    expect(result.trackingId).toBe("submission-1");
    expect(mocks.submissionCount).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordIntegrationEvent).not.toHaveBeenCalled();
  });

  it("rate limits a token after 30 requests in one hour", async () => {
    mocks.submissionCount.mockResolvedValue(30);

    await expect(createPublicMaintenanceRequest(input)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("resolves an optional asset code only inside the token site", async () => {
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-1" });

    await createPublicMaintenanceRequest({ ...input, assetCode: "A-100" });

    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: { siteId: "site-a", code: "A-100", archivedAt: null },
      select: { id: true },
    });
    expect(mocks.txWorkOrderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ assetId: "asset-1" }),
      select: { id: true, number: true, title: true, status: true, requestedAt: true },
    });
    expect(mocks.recordIntegrationEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        payload: expect.objectContaining({
          workOrder: expect.objectContaining({ assetCode: "A-100" }),
        }),
      }),
    );
  });

  it("rejects an unknown asset code instead of crossing site boundaries", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(
      createPublicMaintenanceRequest({ ...input, assetCode: "FOREIGN" }),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
