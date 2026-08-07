import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class StockMovementError extends Error {
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

  return {
    transaction: vi.fn(),
    dbConsumptionFindUnique: vi.fn(),
    txConsumptionFindUnique: vi.fn(),
    partFindFirst: vi.fn(),
    workOrderPartUpsert: vi.fn(),
    consumptionCreate: vi.fn(),
    auditCreate: vi.fn(),
    applyStockMovement: vi.fn(),
    consumeWorkOrderReservation: vi.fn(),
    StockMovementError,
  };
});

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
  StockMovementError: mocks.StockMovementError,
}));
vi.mock("@/lib/inventory/reservations", () => ({
  consumeWorkOrderReservation: mocks.consumeWorkOrderReservation,
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
    mocks.consumeWorkOrderReservation.mockResolvedValue({
      status: "CONSUMED",
      quantity: 2,
      consumedQuantity: 2,
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

  it("routes consumption through the immutable stock ledger and consumes its reservation", async () => {
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
    expect(mocks.consumeWorkOrderReservation).toHaveBeenCalledWith(tx, {
      workOrderId: "wo-1",
      binId: "bin-1",
      partId: "part-1",
      quantity: 2,
      actorId: "tech-1",
    });
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
        afterJson: expect.stringContaining('"reservationStatus":"CONSUMED"'),
      }),
    });
  });

  it("returns an existing consumption without touching ledger or reservation on retry", async () => {
    mocks.txConsumptionFindUnique.mockResolvedValue({
      id: "consumption-1",
      idempotencyKey: "consume-0001",
      part: { id: "part-1" },
      bin: { id: "bin-1" },
    });

    const result = await consumeWorkOrderPart(input);

    expect(result.idempotent).toBe(true);
    expect(mocks.applyStockMovement).not.toHaveBeenCalled();
    expect(mocks.consumeWorkOrderReservation).not.toHaveBeenCalled();
    expect(mocks.consumptionCreate).not.toHaveBeenCalled();
  });

  it("does not consume a reservation when stock movement is rejected", async () => {
    mocks.applyStockMovement.mockRejectedValue(
      new mocks.StockMovementError("INSUFFICIENT_STOCK", "Not enough available stock"),
    );

    await expect(consumeWorkOrderPart(input)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });
    expect(mocks.consumeWorkOrderReservation).not.toHaveBeenCalled();
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
