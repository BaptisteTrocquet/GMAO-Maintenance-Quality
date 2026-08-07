import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  movementFindUnique: vi.fn(),
  movementCreate: vi.fn(),
  binFindFirst: vi.fn(),
  partFindFirst: vi.fn(),
  partFindUnique: vi.fn(),
  partUpdateMany: vi.fn(),
  partUpdate: vi.fn(),
  balanceFindUnique: vi.fn(),
  balanceUpdateMany: vi.fn(),
  balanceUpsert: vi.fn(),
  balanceCreate: vi.fn(),
  auditCreate: vi.fn(),
  reservedQuantityForOthers: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/inventory/reservations", () => ({
  reservedQuantityForOthers: mocks.reservedQuantityForOthers,
}));

import { applyStockMovement } from "@/lib/inventory/stock";

const tx = {
  stockMovement: {
    findUnique: mocks.movementFindUnique,
    create: mocks.movementCreate,
  },
  stockBin: { findFirst: mocks.binFindFirst },
  part: {
    findFirst: mocks.partFindFirst,
    findUnique: mocks.partFindUnique,
    updateMany: mocks.partUpdateMany,
    update: mocks.partUpdate,
  },
  stockBalance: {
    findUnique: mocks.balanceFindUnique,
    updateMany: mocks.balanceUpdateMany,
    upsert: mocks.balanceUpsert,
    create: mocks.balanceCreate,
  },
  auditLog: { create: mocks.auditCreate },
} as unknown as Parameters<typeof applyStockMovement>[0];

const baseInput = {
  organizationId: "org-a",
  siteId: "site-a",
  binId: "bin-a",
  partId: "part-a",
  idempotencyKey: "movement-0001",
  actorId: "manager-1",
};

describe("inventory stock ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.movementFindUnique.mockResolvedValue(null);
    mocks.binFindFirst.mockResolvedValue({ id: "bin-a" });
    mocks.partFindFirst.mockResolvedValue({
      id: "part-a",
      quantityOnHand: 10,
      unitCost: null,
    });
    mocks.partFindUnique.mockResolvedValue({ quantityOnHand: 8 });
    mocks.partUpdateMany.mockResolvedValue({ count: 1 });
    mocks.partUpdate.mockResolvedValue({ quantityOnHand: 12 });
    mocks.balanceFindUnique.mockResolvedValue({ id: "balance-a", quantity: 5 });
    mocks.balanceUpdateMany.mockResolvedValue({ count: 1 });
    mocks.balanceUpsert.mockResolvedValue({ id: "balance-a" });
    mocks.balanceCreate.mockResolvedValue({ id: "balance-a" });
    mocks.reservedQuantityForOthers.mockResolvedValue(0);
    mocks.movementCreate.mockImplementation(async ({ data }) => ({
      id: "movement-a",
      ...data,
      createdAt: new Date("2026-08-08T00:00:00.000Z"),
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-a" });
  });

  it("records a receipt and updates bin plus part aggregate atomically", async () => {
    const result = await applyStockMovement(tx, {
      ...baseInput,
      type: "RECEIPT",
      quantity: 2,
    });

    expect(result.idempotent).toBe(false);
    expect(mocks.balanceUpsert).toHaveBeenCalledWith({
      where: { binId_partId: { binId: "bin-a", partId: "part-a" } },
      create: { binId: "bin-a", partId: "part-a", quantity: 2 },
      update: { quantity: { increment: 2 } },
    });
    expect(mocks.partUpdate).toHaveBeenCalledWith({
      where: { id: "part-a" },
      data: { quantityOnHand: { increment: 2 } },
      select: { quantityOnHand: true },
    });
    expect(mocks.movementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "RECEIPT",
        delta: 2,
        balanceAfter: 7,
        partQuantityAfter: 12,
      }),
    });
  });

  it("issues only when both bin and aggregate can be decremented", async () => {
    const result = await applyStockMovement(tx, {
      ...baseInput,
      type: "ISSUE",
      quantity: 2,
    });

    expect(result.idempotent).toBe(false);
    expect(mocks.reservedQuantityForOthers).toHaveBeenCalledWith(tx, {
      binId: "bin-a",
      partId: "part-a",
      workOrderId: null,
    });
    expect(mocks.balanceUpdateMany).toHaveBeenCalledWith({
      where: { id: "balance-a", quantity: { gte: 2 } },
      data: { quantity: { decrement: 2 } },
    });
    expect(mocks.partUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "part-a",
        organizationId: "org-a",
        quantityOnHand: { gte: 2 },
      },
      data: { quantityOnHand: { decrement: 2 } },
    });
    expect(mocks.movementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ delta: -2, balanceAfter: 3, partQuantityAfter: 8 }),
    });
  });

  it("prevents a generic issue from consuming stock reserved for work orders", async () => {
    mocks.reservedQuantityForOthers.mockResolvedValue(4);

    await expect(
      applyStockMovement(tx, { ...baseInput, type: "ISSUE", quantity: 2 }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    expect(mocks.balanceUpdateMany).not.toHaveBeenCalled();
    expect(mocks.movementCreate).not.toHaveBeenCalled();
  });

  it("lets a work order consume its own reservation while protecting other reservations", async () => {
    mocks.reservedQuantityForOthers.mockResolvedValue(2);

    await applyStockMovement(tx, {
      ...baseInput,
      type: "WORK_ORDER_CONSUMPTION",
      quantity: 3,
      referenceType: "WorkOrder",
      referenceId: "wo-1",
    });

    expect(mocks.reservedQuantityForOthers).toHaveBeenCalledWith(tx, {
      binId: "bin-a",
      partId: "part-a",
      workOrderId: "wo-1",
    });
    expect(mocks.balanceUpdateMany).toHaveBeenCalled();
  });

  it("prevents silent negative stock when a concurrent issue exhausts the bin", async () => {
    mocks.balanceUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      applyStockMovement(tx, { ...baseInput, type: "ISSUE", quantity: 2 }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    expect(mocks.partUpdateMany).not.toHaveBeenCalled();
    expect(mocks.movementCreate).not.toHaveBeenCalled();
  });

  it("records adjustments as immutable deltas with an audit event", async () => {
    mocks.partFindUnique.mockResolvedValue({ quantityOnHand: 6 });

    await applyStockMovement(tx, {
      ...baseInput,
      type: "ADJUSTMENT",
      targetQuantity: 1,
      note: "Cycle count correction",
    });

    expect(mocks.movementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "ADJUSTMENT",
        delta: -4,
        balanceAfter: 1,
        partQuantityAfter: 6,
        note: "Cycle count correction",
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "STOCK_ADJUSTED" }),
    });
  });

  it("returns the same movement on an identical idempotent retry", async () => {
    const first = await applyStockMovement(tx, {
      ...baseInput,
      type: "RECEIPT",
      quantity: 2,
    });
    mocks.movementFindUnique.mockResolvedValue(first.movement);
    mocks.balanceUpsert.mockClear();
    mocks.partUpdate.mockClear();
    mocks.movementCreate.mockClear();

    const retry = await applyStockMovement(tx, {
      ...baseInput,
      type: "RECEIPT",
      quantity: 2,
    });

    expect(retry.idempotent).toBe(true);
    expect(mocks.balanceUpsert).not.toHaveBeenCalled();
    expect(mocks.partUpdate).not.toHaveBeenCalled();
    expect(mocks.movementCreate).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key for different movement data", async () => {
    const first = await applyStockMovement(tx, {
      ...baseInput,
      type: "RECEIPT",
      quantity: 2,
    });
    mocks.movementFindUnique.mockResolvedValue(first.movement);

    await expect(
      applyStockMovement(tx, {
        ...baseInput,
        type: "RECEIPT",
        quantity: 3,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
