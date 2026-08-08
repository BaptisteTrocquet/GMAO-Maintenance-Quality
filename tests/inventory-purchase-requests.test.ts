import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  siteFindFirst: vi.fn(),
  partFindFirst: vi.fn(),
  partSupplierFindFirst: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    create: mocks.auditCreate,
  },
  site: { findFirst: mocks.siteFindFirst },
  part: { findFirst: mocks.partFindFirst },
  partSupplier: { findFirst: mocks.partSupplierFindFirst },
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
  createPurchaseRequest,
  transitionPurchaseRequest,
  updatePurchaseRequestDraft,
} from "@/lib/inventory/purchase-requests";

const createInput = {
  organizationId: "org-a",
  siteId: "site-a",
  requestKey: "reorder-sp-001-2026-08-08",
  reason: "Replenish critical spare",
  neededBy: new Date("2026-08-20T00:00:00.000Z"),
  lines: [{ partId: "part-1", quantity: 4 }],
  actorId: "manager-1",
};

describe("purchase request workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditFindMany.mockResolvedValue([]);
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
      supplierPartNumber: "GCS-SEAL-200",
      preferred: true,
      unitCost: null,
      currency: "EUR",
      supplier: {
        id: "supplier-1",
        code: "SUP-001",
        name: "Generic Components Supply",
      },
    });
  });

  it("creates an idempotent draft using the preferred supplier reference", async () => {
    const result = await createPurchaseRequest(createInput);

    expect(result.idempotent).toBe(false);
    expect(result.purchaseRequest.status).toBe("DRAFT");
    expect(result.purchaseRequest.lines[0]).toMatchObject({
      partId: "part-1",
      quantity: 4,
      supplierId: "supplier-1",
      supplierCode: "SUP-001",
      supplierPartNumber: "GCS-SEAL-200",
    });
    expect(mocks.partSupplierFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ preferred: true, active: true }),
      }),
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "PurchaseRequest",
        action: "CREATED",
        actorId: "manager-1",
      }),
    });

    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify(result.purchaseRequest),
    });
    mocks.auditCreate.mockClear();

    const retry = await createPurchaseRequest(createInput);
    expect(retry.idempotent).toBe(true);
    expect(retry.purchaseRequest.id).toBe(result.purchaseRequest.id);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects reuse of requestKey for a different payload", async () => {
    const first = await createPurchaseRequest(createInput);
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify(first.purchaseRequest),
    });

    await expect(
      createPurchaseRequest({
        ...createInput,
        lines: [{ partId: "part-1", quantity: 8 }],
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("does not allow approving a draft directly", async () => {
    const created = await createPurchaseRequest(createInput);
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify(created.purchaseRequest),
    });

    await expect(
      transitionPurchaseRequest({
        organizationId: "org-a",
        siteId: "site-a",
        requestId: created.purchaseRequest.id,
        action: "APPROVE",
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
  });

  it("submits a draft and records the transition", async () => {
    const created = await createPurchaseRequest(createInput);
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify(created.purchaseRequest),
    });
    mocks.auditCreate.mockClear();

    const submitted = await transitionPurchaseRequest({
      organizationId: "org-a",
      siteId: "site-a",
      requestId: created.purchaseRequest.id,
      action: "SUBMIT",
      actorId: "manager-1",
    });

    expect(submitted.status).toBe("SUBMITTED");
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "SUBMITTED" }),
    });
  });

  it("prevents line edits after submission", async () => {
    const created = await createPurchaseRequest(createInput);
    const submitted = { ...created.purchaseRequest, status: "SUBMITTED" as const };
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(submitted) });

    await expect(
      updatePurchaseRequestDraft({
        organizationId: "org-a",
        siteId: "site-a",
        requestId: submitted.id,
        reason: "Changed reason",
        neededBy: null,
        lines: [{ partId: "part-1", quantity: 2 }],
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "DRAFT_REQUIRED" });
  });

  it("requires an active supplier reference when a supplier is explicitly selected", async () => {
    mocks.partSupplierFindFirst.mockResolvedValue(null);

    await expect(
      createPurchaseRequest({
        ...createInput,
        lines: [{ partId: "part-1", supplierId: "supplier-x", quantity: 4 }],
      }),
    ).rejects.toMatchObject({ code: "SUPPLIER_REFERENCE_NOT_FOUND" });
  });
});
