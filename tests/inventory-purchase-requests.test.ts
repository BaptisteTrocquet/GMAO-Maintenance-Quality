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
    auditLog: { findFirst: mocks.auditFindFirst, findMany: mocks.auditFindMany },
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
  requestKey: "reorder-bin-a-sp-001-2026-08-08",
  reason: "Replenish minimum stock",
  neededBy: new Date("2026-08-20T00:00:00.000Z"),
  lines: [{ partId: "part-1", quantity: 4 }],
  actorId: "manager-1",
};

function auditSnapshot() {
  const call = mocks.auditCreate.mock.calls.at(-1)?.[0];
  const afterJson = call?.data?.afterJson;
  if (typeof afterJson !== "string") throw new Error("expected purchase request audit snapshot");
  return JSON.parse(afterJson) as Record<string, unknown>;
}

describe("inventory purchase requests", () => {
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
      unitCost: 12.5,
    });
    mocks.partSupplierFindFirst.mockResolvedValue({
      partId: "part-1",
      supplierId: "supplier-1",
      supplierPartNumber: "SUP-SP-001",
      preferred: true,
      unitCost: 11.75,
      currency: "EUR",
      supplier: { id: "supplier-1", code: "SUP-001", name: "Demo Industrial Supply" },
    });
  });

  it("snapshots the preferred supplier reference into a draft request", async () => {
    const result = await createPurchaseRequest(createInput);

    expect(result.idempotent).toBe(false);
    expect(result.purchaseRequest.status).toBe("DRAFT");
    expect(result.purchaseRequest.lines).toEqual([
      expect.objectContaining({
        partId: "part-1",
        sku: "SP-001",
        quantity: 4,
        supplierId: "supplier-1",
        supplierPartNumber: "SUP-SP-001",
        unitCost: 11.75,
        currency: "EUR",
      }),
    ]);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "PurchaseRequest",
        action: "CREATED",
      }),
    });
  });

  it("returns an identical request idempotently for the same requestKey and payload", async () => {
    const first = await createPurchaseRequest(createInput);
    const snapshot = auditSnapshot();
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(snapshot) });
    mocks.auditCreate.mockClear();

    const retry = await createPurchaseRequest(createInput);

    expect(retry.idempotent).toBe(true);
    expect(retry.purchaseRequest.id).toBe(first.purchaseRequest.id);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects reuse of a requestKey with a different payload", async () => {
    await createPurchaseRequest(createInput);
    const snapshot = auditSnapshot();
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(snapshot) });

    await expect(
      createPurchaseRequest({
        ...createInput,
        lines: [{ partId: "part-1", quantity: 8 }],
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("allows edits only while the purchase request is in DRAFT", async () => {
    await createPurchaseRequest(createInput);
    const snapshot = auditSnapshot();
    snapshot.status = "SUBMITTED";
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(snapshot) });

    await expect(
      updatePurchaseRequestDraft({
        organizationId: "org-a",
        siteId: "site-a",
        requestId: String(snapshot.id),
        reason: "Changed",
        neededBy: null,
        lines: [{ partId: "part-1", quantity: 4 }],
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "DRAFT_REQUIRED" });
  });

  it("enforces the submit then approve workflow", async () => {
    await createPurchaseRequest(createInput);
    const draft = auditSnapshot();
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(draft) });

    const submitted = await transitionPurchaseRequest({
      organizationId: "org-a",
      siteId: "site-a",
      requestId: String(draft.id),
      action: "SUBMIT",
      actorId: "manager-1",
    });
    expect(submitted.status).toBe("SUBMITTED");

    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(submitted) });
    const approved = await transitionPurchaseRequest({
      organizationId: "org-a",
      siteId: "site-a",
      requestId: String(draft.id),
      action: "APPROVE",
      note: "Budget confirmed",
      actorId: "manager-2",
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.decisionNote).toBe("Budget confirmed");

    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(approved) });
    await expect(
      transitionPurchaseRequest({
        organizationId: "org-a",
        siteId: "site-a",
        requestId: String(draft.id),
        action: "SUBMIT",
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
  });
});
