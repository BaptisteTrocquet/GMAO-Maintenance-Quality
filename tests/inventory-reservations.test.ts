import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  workOrderFindFirst: vi.fn(),
  binFindFirst: vi.fn(),
  partFindFirst: vi.fn(),
  balanceFindUnique: vi.fn(),
  balanceUpdate: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  workOrder: { findFirst: mocks.workOrderFindFirst },
  stockBin: { findFirst: mocks.binFindFirst },
  part: { findFirst: mocks.partFindFirst },
  stockBalance: {
    findUnique: mocks.balanceFindUnique,
    update: mocks.balanceUpdate,
  },
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    auditLog: { findMany: mocks.auditFindMany },
  },
}));

import {
  consumeWorkOrderReservation,
  releaseWorkOrderStock,
  reserveWorkOrderStock,
} from "@/lib/inventory/reservations";

function snapshot(input?: {
  workOrderId?: string;
  quantity?: number;
  consumedQuantity?: number;
  status?: "ACTIVE" | "RELEASED" | "CONSUMED";
}) {
  const workOrderId = input?.workOrderId ?? "wo-1";
  return {
    id: `reservation-${workOrderId}`,
    organizationId: "org-a",
    siteId: "site-a",
    workOrderId,
    binId: "bin-1",
    partId: "part-1",
    quantity: input?.quantity ?? 2,
    consumedQuantity: input?.consumedQuantity ?? 0,
    status: input?.status ?? "ACTIVE",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

const reserveInput = {
  organizationId: "org-a",
  siteId: "site-a",
  workOrderId: "wo-1",
  binId: "bin-1",
  partId: "part-1",
  quantity: 2,
  actorId: "manager-1",
};

describe("work-order stock reservations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.workOrderFindFirst.mockResolvedValue({ id: "wo-1", status: "PLANNED" });
    mocks.binFindFirst.mockResolvedValue({ id: "bin-1" });
    mocks.partFindFirst.mockResolvedValue({ id: "part-1" });
    mocks.balanceFindUnique.mockResolvedValue({ id: "balance-1", quantity: 5 });
    mocks.balanceUpdate.mockResolvedValue({ id: "balance-1", quantity: 5 });
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("reserves available stock and serializes on the balance row", async () => {
    const result = await reserveWorkOrderStock(reserveInput);

    expect(result).toMatchObject({
      workOrderId: "wo-1",
      binId: "bin-1",
      partId: "part-1",
      quantity: 2,
      consumedQuantity: 0,
      status: "ACTIVE",
    });
    expect(mocks.balanceUpdate).toHaveBeenCalledWith({
      where: { id: "balance-1" },
      data: { quantity: { increment: 0 } },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "StockReservation",
        action: "RESERVED",
      }),
    });
  });

  it("refuses over-reservation after stock held by another work order", async () => {
    const other = snapshot({ workOrderId: "wo-2", quantity: 4 });
    mocks.auditFindMany.mockResolvedValue([
      { entityId: other.id, afterJson: JSON.stringify(other) },
    ]);

    await expect(reserveWorkOrderStock(reserveInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_AVAILABLE_STOCK",
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("does not double-count the work order's own reservation when resizing", async () => {
    const own = snapshot({ quantity: 3, consumedQuantity: 1 });
    const other = snapshot({ workOrderId: "wo-2", quantity: 2 });
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(own) });
    mocks.auditFindMany.mockResolvedValue([
      { entityId: own.id, afterJson: JSON.stringify(own) },
      { entityId: other.id, afterJson: JSON.stringify(other) },
    ]);

    const result = await reserveWorkOrderStock({ ...reserveInput, quantity: 4 });

    expect(result).toMatchObject({ quantity: 4, consumedQuantity: 1, status: "ACTIVE" });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "UPDATED" }),
    });
  });

  it("rejects shrinking the reservation below quantity already consumed", async () => {
    const own = snapshot({ quantity: 4, consumedQuantity: 3 });
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(own) });

    await expect(
      reserveWorkOrderStock({ ...reserveInput, quantity: 2 }),
    ).rejects.toMatchObject({ code: "RESERVATION_QUANTITY_CONFLICT" });
  });

  it("releases an active reservation without changing physical stock", async () => {
    const own = snapshot({ quantity: 3 });
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(own) });

    const result = await releaseWorkOrderStock(reserveInput);

    expect(result.status).toBe("RELEASED");
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "RELEASED" }),
    });
  });

  it("consumes the reservation incrementally as work-order stock is issued", async () => {
    const own = snapshot({ quantity: 3, consumedQuantity: 0 });
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(own) });

    const partial = await consumeWorkOrderReservation(tx as never, {
      workOrderId: "wo-1",
      binId: "bin-1",
      partId: "part-1",
      quantity: 2,
      actorId: "tech-1",
    });

    expect(partial).toMatchObject({ consumedQuantity: 2, status: "ACTIVE" });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PARTIALLY_CONSUMED" }),
    });

    mocks.auditCreate.mockClear();
    const afterPartial = snapshot({ quantity: 3, consumedQuantity: 2 });
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(afterPartial) });

    const completed = await consumeWorkOrderReservation(tx as never, {
      workOrderId: "wo-1",
      binId: "bin-1",
      partId: "part-1",
      quantity: 1,
      actorId: "tech-1",
    });

    expect(completed).toMatchObject({ consumedQuantity: 3, status: "CONSUMED" });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CONSUMED" }),
    });
  });
});
