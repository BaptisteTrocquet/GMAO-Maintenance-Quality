import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  binFindFirst: vi.fn(),
  partFindFirst: vi.fn(),
  balanceFindUnique: vi.fn(),
  reservedQuantity: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
  stockBin: { findFirst: mocks.binFindFirst },
  part: { findFirst: mocks.partFindFirst },
  stockBalance: { findUnique: mocks.balanceFindUnique },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    auditLog: { findMany: mocks.auditFindMany },
  },
}));
vi.mock("@/lib/inventory/reservations", () => ({
  reservedQuantityForOthers: mocks.reservedQuantity,
}));

import {
  getReorderAlerts,
  setReorderPolicy,
} from "@/lib/inventory/reorder";

function policy(overrides?: Partial<{
  minQuantity: number;
  maxQuantity: number;
  reorderQuantity: number | null;
  active: boolean;
}>) {
  return {
    id: "policy-1",
    organizationId: "org-a",
    siteId: "site-a",
    binId: "bin-1",
    partId: "part-1",
    minQuantity: overrides?.minQuantity ?? 2,
    maxQuantity: overrides?.maxQuantity ?? 10,
    reorderQuantity: overrides?.reorderQuantity ?? null,
    active: overrides?.active ?? true,
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

describe("inventory reorder policies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.binFindFirst.mockResolvedValue({
      id: "bin-1",
      code: "A-01",
      name: "Rack A / 01",
      warehouse: { id: "wh-1", code: "MAIN", name: "Main warehouse" },
    });
    mocks.partFindFirst.mockResolvedValue({
      id: "part-1",
      sku: "SP-001",
      name: "Seal kit",
      unit: "EA",
    });
    mocks.balanceFindUnique.mockResolvedValue({ quantity: 5 });
    mocks.reservedQuantity.mockResolvedValue(0);
  });

  it("rejects max below min before writing policy state", async () => {
    await expect(
      setReorderPolicy({
        organizationId: "org-a",
        siteId: "site-a",
        binId: "bin-1",
        partId: "part-1",
        minQuantity: 5,
        maxQuantity: 4,
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_MIN_MAX" });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("stores an audited bin-level min/max policy", async () => {
    const result = await setReorderPolicy({
      organizationId: "org-a",
      siteId: "site-a",
      binId: "bin-1",
      partId: "part-1",
      minQuantity: 2,
      maxQuantity: 10,
      actorId: "manager-1",
    });

    expect(result).toMatchObject({ minQuantity: 2, maxQuantity: 10, active: true });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "StockReorderPolicy",
        action: "CREATED",
        afterJson: expect.stringContaining('"binId":"bin-1","partId":"part-1"'),
      }),
    });
  });

  it("triggers reorder from available stock after reservations", async () => {
    const current = policy();
    mocks.auditFindMany.mockResolvedValue([
      { entityId: current.id, afterJson: JSON.stringify(current) },
    ]);
    mocks.balanceFindUnique.mockResolvedValue({ quantity: 5 });
    mocks.reservedQuantity.mockResolvedValue(4);

    const alerts = await getReorderAlerts({ organizationId: "org-a", siteId: "site-a" });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      onHand: 5,
      reserved: 4,
      available: 1,
      status: "REORDER",
      suggestedOrderQuantity: 9,
    });
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          afterJson: { contains: '"organizationId":"org-a","siteId":"site-a"' },
        }),
      }),
    );
  });

  it("marks zero available stock as out of stock", async () => {
    const current = policy();
    mocks.auditFindMany.mockResolvedValue([
      { entityId: current.id, afterJson: JSON.stringify(current) },
    ]);
    mocks.balanceFindUnique.mockResolvedValue({ quantity: 3 });
    mocks.reservedQuantity.mockResolvedValue(3);

    const alerts = await getReorderAlerts({ organizationId: "org-a", siteId: "site-a" });

    expect(alerts[0]).toMatchObject({
      available: 0,
      status: "OUT_OF_STOCK",
      suggestedOrderQuantity: 10,
    });
  });

  it("uses fixed reorder quantity when configured", async () => {
    const current = policy({ reorderQuantity: 6 });
    mocks.auditFindMany.mockResolvedValue([
      { entityId: current.id, afterJson: JSON.stringify(current) },
    ]);
    mocks.balanceFindUnique.mockResolvedValue({ quantity: 2 });

    const alerts = await getReorderAlerts({ organizationId: "org-a", siteId: "site-a" });

    expect(alerts[0]?.suggestedOrderQuantity).toBe(6);
  });

  it("omits healthy policies unless includeOk is requested", async () => {
    const current = policy();
    mocks.auditFindMany.mockResolvedValue([
      { entityId: current.id, afterJson: JSON.stringify(current) },
    ]);
    mocks.balanceFindUnique.mockResolvedValue({ quantity: 8 });

    expect(
      await getReorderAlerts({ organizationId: "org-a", siteId: "site-a" }),
    ).toEqual([]);

    const all = await getReorderAlerts({
      organizationId: "org-a",
      siteId: "site-a",
      includeOk: true,
    });
    expect(all[0]).toMatchObject({ status: "OK", suggestedOrderQuantity: 0 });
  });
});
