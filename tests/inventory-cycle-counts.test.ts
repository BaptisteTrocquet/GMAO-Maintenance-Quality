import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class StockMovementError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    transaction: vi.fn(),
    binFindFirst: vi.fn(),
    balanceFindMany: vi.fn(),
    auditFindFirst: vi.fn(),
    auditFindMany: vi.fn(),
    auditCreate: vi.fn(),
    applyStockMovement: vi.fn(),
    StockMovementError,
  };
});

const tx = {
  stockBin: { findFirst: mocks.binFindFirst },
  stockBalance: { findMany: mocks.balanceFindMany },
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
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
vi.mock("@/lib/inventory/stock", () => ({
  applyStockMovement: mocks.applyStockMovement,
  StockMovementError: mocks.StockMovementError,
}));

import {
  completeCycleCount,
  createCycleCount,
  recordCycleCountItem,
} from "@/lib/inventory/cycle-counts";

function openSnapshot(overrides?: {
  countedQuantity?: number | null;
  expectedQuantity?: number;
}) {
  return {
    id: "count-1",
    organizationId: "org-a",
    siteId: "site-a",
    binId: "bin-1",
    warehouseCode: "MAIN",
    binCode: "A-01",
    status: "OPEN" as const,
    items: [
      {
        partId: "part-1",
        sku: "SP-001",
        name: "Seal kit",
        unit: "EA",
        expectedQuantity: overrides?.expectedQuantity ?? 5,
        countedQuantity: overrides?.countedQuantity ?? null,
        countedById: overrides?.countedQuantity === undefined || overrides?.countedQuantity === null ? null : "counter-1",
        countedAt: overrides?.countedQuantity === undefined || overrides?.countedQuantity === null ? null : "2026-08-08T00:00:00.000Z",
      },
    ],
    createdById: "manager-1",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
  };
}

describe("inventory cycle counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.binFindFirst.mockResolvedValue({
      id: "bin-1",
      code: "A-01",
      warehouse: { code: "MAIN" },
    });
    mocks.balanceFindMany.mockResolvedValue([
      {
        partId: "part-1",
        quantity: 5,
        part: { id: "part-1", sku: "SP-001", name: "Seal kit", unit: "EA" },
      },
    ]);
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.applyStockMovement.mockResolvedValue({
      movement: { id: "movement-1" },
      idempotent: false,
    });
  });

  it("captures the expected bin balance without changing physical stock", async () => {
    const result = await createCycleCount({
      organizationId: "org-a",
      siteId: "site-a",
      binId: "bin-1",
      actorId: "manager-1",
    });

    expect(result.status).toBe("OPEN");
    expect(result.items[0]).toMatchObject({
      partId: "part-1",
      expectedQuantity: 5,
      countedQuantity: null,
    });
    expect(mocks.applyStockMovement).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "StockCycleCount",
        action: "CREATED",
      }),
    });
  });

  it("records counted quantity without posting an adjustment", async () => {
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(openSnapshot()) });

    const result = await recordCycleCountItem({
      organizationId: "org-a",
      siteId: "site-a",
      countId: "count-1",
      partId: "part-1",
      countedQuantity: 4,
      actorId: "counter-1",
    });

    expect(result.items[0]).toMatchObject({
      countedQuantity: 4,
      countedById: "counter-1",
    });
    expect(mocks.applyStockMovement).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "COUNT_RECORDED" }),
    });
  });

  it("refuses completion until every item is counted", async () => {
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(openSnapshot()) });

    await expect(
      completeCycleCount({
        organizationId: "org-a",
        siteId: "site-a",
        countId: "count-1",
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "COUNT_INCOMPLETE" });

    expect(mocks.applyStockMovement).not.toHaveBeenCalled();
  });

  it("fails stale instead of adjusting when stock changed after the snapshot", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify(openSnapshot({ countedQuantity: 4 })),
    });
    mocks.balanceFindMany.mockResolvedValue([{ partId: "part-1", quantity: 6 }]);

    await expect(
      completeCycleCount({
        organizationId: "org-a",
        siteId: "site-a",
        countId: "count-1",
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "COUNT_STALE" });

    expect(mocks.applyStockMovement).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "COMPLETED" }),
    });
  });

  it("posts explicit ledger adjustments only at successful completion", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify(openSnapshot({ countedQuantity: 4 })),
    });
    mocks.balanceFindMany.mockResolvedValue([{ partId: "part-1", quantity: 5 }]);

    const result = await completeCycleCount({
      organizationId: "org-a",
      siteId: "site-a",
      countId: "count-1",
      actorId: "manager-1",
    });

    expect(result.status).toBe("COMPLETED");
    expect(mocks.applyStockMovement).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        binId: "bin-1",
        partId: "part-1",
        type: "ADJUSTMENT",
        targetQuantity: 4,
        idempotencyKey: "cycle:count-1:part-1",
        referenceType: "CycleCount",
        referenceId: "count-1",
      }),
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "COMPLETED" }),
    });
  });

  it("maps reservation or ledger protection failures to a blocked count", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify(openSnapshot({ countedQuantity: 1 })),
    });
    mocks.balanceFindMany.mockResolvedValue([{ partId: "part-1", quantity: 5 }]);
    mocks.applyStockMovement.mockRejectedValue(
      new mocks.StockMovementError("INSUFFICIENT_STOCK", "Reserved stock exceeds the physical count"),
    );

    await expect(
      completeCycleCount({
        organizationId: "org-a",
        siteId: "site-a",
        countId: "count-1",
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "COUNT_ADJUSTMENT_BLOCKED" });
  });
});
