import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  txAuditFindMany: vi.fn(),
  dbAuditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  siteFindFirst: vi.fn(),
  partFindFirst: vi.fn(),
  partSupplierFindFirst: vi.fn(),
}));

const tx = {
  auditLog: {
    findMany: mocks.txAuditFindMany,
    create: mocks.auditCreate,
  },
  site: { findFirst: mocks.siteFindFirst },
  part: { findFirst: mocks.partFindFirst },
  partSupplier: { findFirst: mocks.partSupplierFindFirst },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    auditLog: { findMany: mocks.dbAuditFindMany },
  },
}));

import {
  createPurchaseRequest,
  listPurchaseRequests,
  transitionPurchaseRequest,
  updatePurchaseRequestDraft,
  type PurchaseRequestSnapshot,
} from "@/lib/inventory/purchase-requests";

const baseLine = { partId: "part-1", quantity: 3 };

function snapshot(overrides: Partial<PurchaseRequestSnapshot> = {}): PurchaseRequestSnapshot {
  return {
    id: "request-1",
    version: 1,
    requestNumber: "PR-REQUEST1",
    requestKey: "reorder-bin-a-part-1",
    requestHash: "hash-1",
    organizationId: "org-a",
    siteId: "site-a",
    requestedById: "manager-1",
    status: "DRAFT",
    reason: "Low stock",
    neededBy: "2026-08-20T00:00:00.000Z",
    decisionNote: null,
    decisionById: null,
    submittedAt: null,
    decidedAt: null,
    cancelledAt: null,
    lines: [
      {
        id: "line-1",
        partId: "part-1",
        sku: "SP-001",
        partName: "Generic seal kit",
        unit: "EA",
        quantity: 3,
        supplierId: "supplier-1",
        supplierCode: "SUP-001",
        supplierName: "Demo Industrial Supply",
        supplierPartNumber: "SUP-SP-001",
        unitCost: 12.5,
        currency: "EUR",
      },
    ],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("purchase request foundation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.txAuditFindMany.mockResolvedValue([]);
    mocks.dbAuditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.partFindFirst.mockResolvedValue({
      id: "part-1",
      sku: "SP-001",
      name: "Generic seal kit",
      unit: "EA",
      unitCost: null,
    });
    mocks.partSupplierFindFirst.mockResolvedValue({
      partId: "part-1",
      supplierId: "supplier-1",
      supplierPartNumber: "SUP-SP-001",
      unitCost: 12.5,
      currency: "EUR",
      supplier: { id: "supplier-1", code: "SUP-001", name: "Demo Industrial Supply" },
    });
  });

  it("creates a versioned draft using the preferred supplier snapshot", async () => {
    const result = await createPurchaseRequest({
      organizationId: "org-a",
      siteId: "site-a",
      requestKey: "reorder-bin-a-part-1",
      reason: "Low stock",
      lines: [baseLine],
      actorId: "manager-1",
    });

    expect(result.idempotent).toBe(false);
    expect(result.purchaseRequest.version).toBe(1);
    expect(result.purchaseRequest.status).toBe("DRAFT");
    expect(result.purchaseRequest.lines[0]).toMatchObject({
      partId: "part-1",
      supplierId: "supplier-1",
      supplierPartNumber: "SUP-SP-001",
      unitCost: 12.5,
      currency: "EUR",
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.stringMatching(/^purchase-request:.*:v1$/),
        entityType: "PurchaseRequest",
        action: "CREATED",
        actorId: "manager-1",
      }),
    });
  });

  it("returns the current snapshot for an identical idempotent create retry", async () => {
    const first = await createPurchaseRequest({
      organizationId: "org-a",
      siteId: "site-a",
      requestKey: "reorder-bin-a-part-1",
      lines: [baseLine],
      actorId: "manager-1",
    });
    mocks.txAuditFindMany.mockResolvedValue([
      { afterJson: JSON.stringify(first.purchaseRequest) },
    ]);
    mocks.auditCreate.mockClear();

    const retry = await createPurchaseRequest({
      organizationId: "org-a",
      siteId: "site-a",
      requestKey: "reorder-bin-a-part-1",
      lines: [baseLine],
      actorId: "manager-1",
    });

    expect(retry.idempotent).toBe(true);
    expect(retry.purchaseRequest.id).toBe(first.purchaseRequest.id);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects reuse of a request key for a different payload", async () => {
    const first = await createPurchaseRequest({
      organizationId: "org-a",
      siteId: "site-a",
      requestKey: "reorder-bin-a-part-1",
      lines: [baseLine],
      actorId: "manager-1",
    });
    mocks.txAuditFindMany.mockResolvedValue([
      { afterJson: JSON.stringify(first.purchaseRequest) },
    ]);

    await expect(
      createPurchaseRequest({
        organizationId: "org-a",
        siteId: "site-a",
        requestKey: "reorder-bin-a-part-1",
        lines: [{ ...baseLine, quantity: 4 }],
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects duplicate part and supplier selections", async () => {
    await expect(
      createPurchaseRequest({
        organizationId: "org-a",
        siteId: "site-a",
        requestKey: "duplicate-lines",
        lines: [baseLine, baseLine],
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_LINE" });
  });

  it("preserves omitted draft fields during a partial edit", async () => {
    const previous = snapshot();
    mocks.txAuditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(previous) }]);

    const updated = await updatePurchaseRequestDraft({
      organizationId: "org-a",
      siteId: "site-a",
      requestId: previous.id,
      reason: "Production-critical shortage",
      actorId: "manager-1",
    });

    expect(updated.version).toBe(2);
    expect(updated.reason).toBe("Production-critical shortage");
    expect(updated.neededBy).toBe(previous.neededBy);
    expect(updated.lines).toEqual(previous.lines);
    expect(mocks.partFindFirst).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "purchase-request:request-1:v2",
        action: "DRAFT_UPDATED",
      }),
    });
  });

  it("submits a draft and records explicit workflow timestamps", async () => {
    const previous = snapshot();
    mocks.txAuditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(previous) }]);

    const submitted = await transitionPurchaseRequest({
      organizationId: "org-a",
      siteId: "site-a",
      requestId: previous.id,
      action: "SUBMIT",
      actorId: "manager-1",
    });

    expect(submitted.version).toBe(2);
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submittedAt).toBeTruthy();
    expect(submitted.decisionById).toBeNull();
  });

  it("rejects approval before submission", async () => {
    const previous = snapshot();
    mocks.txAuditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(previous) }]);

    await expect(
      transitionPurchaseRequest({
        organizationId: "org-a",
        siteId: "site-a",
        requestId: previous.id,
        action: "APPROVE",
        actorId: "manager-2",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
  });

  it("keeps only the highest version when listing requests", async () => {
    const v1 = snapshot({ version: 1, status: "DRAFT" });
    const v2 = snapshot({
      version: 2,
      status: "SUBMITTED",
      updatedAt: "2026-08-08T01:00:00.000Z",
    });
    mocks.dbAuditFindMany.mockResolvedValue([
      { entityId: v1.id, afterJson: JSON.stringify(v2) },
      { entityId: v1.id, afterJson: JSON.stringify(v1) },
    ]);

    const result = await listPurchaseRequests({
      organizationId: "org-a",
      siteId: "site-a",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.version).toBe(2);
    expect(result[0]?.status).toBe("SUBMITTED");
    expect(mocks.dbAuditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "PurchaseRequest",
        afterJson: { contains: '"organizationId":"org-a","siteId":"site-a"' },
      },
      select: { entityId: true, afterJson: true },
    });
  });
});
