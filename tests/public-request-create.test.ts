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

import { createPublicMaintenanceRequest } from "@/lib/public-requests/create-request";

const token = {
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
} as const;

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
      status: "REQUESTED",
      requestedAt: new Date("2026-08-07T12:00:00.000Z"),
    });
    mocks.txSubmissionCreate.mockResolvedValue({ id: "submission-1" });
    mocks.txTokenUpdate.mockResolvedValue({ id: "token-1" });
    mocks.txAuditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
  });

  it("creates a normal-priority requested corrective WO in the token site", async () => {
    const result = await createPublicMaintenanceRequest(input);

    expect(result.idempotent).toBe(false);
    expect(mocks.txWorkOrderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        siteId: "site-a",
        requesterId: null,
        title: "Machine noise reported",
        type: "CORRECTIVE",
        status: "REQUESTED",
        priority: "NORMAL",
      }),
      select: { id: true, number: true, status: true, requestedAt: true },
    });
    expect(mocks.txSubmissionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenId: "token-1",
        workOrderId: "wo-1",
        idempotencyKey: "request-0001",
        requesterEmail: "requester@example.local",
      }),
    });
    expect(mocks.txAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: null,
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "PUBLIC_REQUEST_CREATED",
      }),
    });
  });

  it("returns an existing work order without a second write on idempotent retry", async () => {
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
    expect(mocks.submissionCount).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
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
      select: { id: true, number: true, status: true, requestedAt: true },
    });
  });

  it("rejects an unknown asset code instead of crossing site boundaries", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    await expect(
      createPublicMaintenanceRequest({ ...input, assetCode: "FOREIGN" }),
    ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
