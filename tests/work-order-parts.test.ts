import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  dbConsumptionFindUnique: vi.fn(),
  txConsumptionFindUnique: vi.fn(),
  partFindFirst: vi.fn(),
  workOrderPartUpsert: vi.fn(),
  consumptionCreate: vi.fn(),
  auditCreate: vi.fn(),
  applyStockMovement: vi.fn(),
}));

class MockStockMovementError extends Error {
  constructor(
    public readonly code:
      | "PART_NOT_FOUND"
      | "BIN_NOT_FOUND"
      | "INSUFFICIENT_STOCK"
      | "IDEMPOTENCY_CONFLICT"
      | "BALANCE_DIVERGENCE",
    message: string,
  ) {
    super(message);
  }
}

const tx = {
  workOrderPartConsumption: {
    findUnique: mocks.txConsumptionFindUnique,
    create: mocks.consumptionCreate,
  },
  part: { findFirst: mocks.partFindFirst },
  workOrderPart: { upsert: mocks.workOrderPartUpsert },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    workOrderPartConsumption: { findUnique: mocks.dbConsumptionFindUnique },
  },
}));
vi.mock("@/lib/inventory/stock", () => ({
  applyStockMovement: mocks.applyStockMovement,
  StockMovementError: MockStockMovementError,
}));

import { consumeWorkOrderPart } from "@/lib/work-orders/parts";

const input = {
  organizationId: "org-a",
  siteId: "site-a",
  workOrderId: "wo-1",
  partId: "part-1",
  binId: "bin-1",
  quantity: 2,
  idempotencyKey: "consume-0001",
  actorId: "tech-1",
};

describe("work order part consumption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.txConsumptionFindUnique.mockResolvedValue(null);
    mocks.dbConsumptionFindUnique.mockResolvedValue(null);
    mocks.partFindFirst.mockResolvedValue({
      id: "part-1",
      sku: "SP-001",
      name: "Generic spare",
      unitCost: null,
    });
    mocks.applyStockMovement.mockResolvedValue({
      movement: { id: "movement-1" },
      idempotent: false,
    });
    mocks.workOrderPartUpsert.mockResolvedValue({ workOrderId: "wo-1", partId: "part-1", quantity: 2 });
    mocks.consumptionCreate.mockResolvedValue({
      id: "consumption-1",
      workOrderId: "wo-1",
      partId: "part-1",
      binId: "bin-1",
      quantity: 2,
      idempotencyKey: "consume-0001",
      part: { id: "part-1", sku: "SP-001" },
      bin: { id: "bin-1" },
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("routes consumption through the immutable stock ledger and records the bin", async () => {
    const result = await consumeWorkOrderPart(input);

    expect(result.idempotent).toBe(false);
    expect(mocks.applyStockMovement).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        binId: "bin-1",
        partId: "part-1",
        type: "WORK_ORDER_CONSUMPTION",
        quantity: 2,
        referenceType: "WorkOrder",
        referenceId: "wo-1",
      }),
    );
    expect(mocks.consumptionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workOrderId: "wo-1",
        partId: "part-1",
        binId: "bin-1",
        quantity: 2,
      }),
      include: { part: true, bin: true },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PART_CONSUMED",
        actorId: "tech-1",
        afterJson: expect.stringContaining('"stockMovementId":"movement-1"'),
      }),
    });
  });

  it("returns an existing consumption without touching the ledger on an idempotent retry", async () => {
    mocks.txConsumptionFindUnique.mockResolvedValue({
      id: "consumption-1",
      idempotencyKey: "consume-0001",
      part: { id: "part-1" },
      bin: { id: "bin-1" },
    });

    const result = await consumeWorkOrderPart(input);

    expect(result.idempotent).toBe(true);
    expect(mocks.applyStockMovement).not.toHaveBeenCalled();
    expect(mocks.consumptionCreate).not.toHaveBeenCalled();
  });

  it("propagates insufficient bin stock without recording consumption", async () => {
    mocks.applyStockMovement.mockRejectedValue(
      new MockStockMovementError("INSUFFICIENT_STOCK", "Not enough stock in bin"),
    );

    await expect(consumeWorkOrderPart(input)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });
    expect(mocks.workOrderPartUpsert).not.toHaveBeenCalled();
    expect(mocks.consumptionCreate).not.toHaveBeenCalled();
  });

  it("recovers a concurrent duplicate-key race as an idempotent retry", async () => {
    mocks.transaction.mockRejectedValue(new Error("unique constraint"));
    mocks.dbConsumptionFindUnique.mockResolvedValue({
      id: "consumption-1",
      idempotencyKey: "consume-0001",
      part: { id: "part-1" },
      bin: { id: "bin-1" },
    });

    const result = await consumeWorkOrderPart(input);

    expect(result.idempotent).toBe(true);
  });
});
