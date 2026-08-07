import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  dbConsumptionFindUnique: vi.fn(),
  txConsumptionFindUnique: vi.fn(),
  partFindFirst: vi.fn(),
  partUpdateMany: vi.fn(),
  workOrderPartUpsert: vi.fn(),
  consumptionCreate: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  workOrderPartConsumption: {
    findUnique: mocks.txConsumptionFindUnique,
    create: mocks.consumptionCreate,
  },
  part: { findFirst: mocks.partFindFirst, updateMany: mocks.partUpdateMany },
  workOrderPart: { upsert: mocks.workOrderPartUpsert },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    workOrderPartConsumption: { findUnique: mocks.dbConsumptionFindUnique },
  },
}));

import { consumeWorkOrderPart } from "@/lib/work-orders/parts";

const input = {
  organizationId: "org-a",
  workOrderId: "wo-1",
  partId: "part-1",
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
    mocks.partUpdateMany.mockResolvedValue({ count: 1 });
    mocks.workOrderPartUpsert.mockResolvedValue({ workOrderId: "wo-1", partId: "part-1", quantity: 2 });
    mocks.consumptionCreate.mockResolvedValue({
      id: "consumption-1",
      workOrderId: "wo-1",
      partId: "part-1",
      quantity: 2,
      idempotencyKey: "consume-0001",
      part: { id: "part-1", sku: "SP-001" },
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("atomically decrements stock and records aggregate and transaction history", async () => {
    const result = await consumeWorkOrderPart(input);

    expect(result.idempotent).toBe(false);
    expect(mocks.partUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "part-1",
        organizationId: "org-a",
        quantityOnHand: { gte: 2 },
      },
      data: { quantityOnHand: { decrement: 2 } },
    });
    expect(mocks.workOrderPartUpsert).toHaveBeenCalledWith({
      where: { workOrderId_partId: { workOrderId: "wo-1", partId: "part-1" } },
      create: expect.objectContaining({ quantity: 2 }),
      update: expect.objectContaining({ quantity: { increment: 2 } }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PART_CONSUMED", actorId: "tech-1" }),
    });
  });

  it("returns an existing consumption without decrementing stock on an idempotent retry", async () => {
    mocks.txConsumptionFindUnique.mockResolvedValue({
      id: "consumption-1",
      idempotencyKey: "consume-0001",
      part: { id: "part-1" },
    });

    const result = await consumeWorkOrderPart(input);

    expect(result.idempotent).toBe(true);
    expect(mocks.partUpdateMany).not.toHaveBeenCalled();
    expect(mocks.consumptionCreate).not.toHaveBeenCalled();
  });

  it("rejects consumption when the conditional stock decrement cannot be applied", async () => {
    mocks.partUpdateMany.mockResolvedValue({ count: 0 });

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
    });

    const result = await consumeWorkOrderPart(input);

    expect(result.idempotent).toBe(true);
  });
});
