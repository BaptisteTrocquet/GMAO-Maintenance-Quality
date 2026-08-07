import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  siteFindFirst: vi.fn(),
  warehouseFindMany: vi.fn(),
  warehouseFindFirst: vi.fn(),
  warehouseCreate: vi.fn(),
  warehouseUpdate: vi.fn(),
  stockBinFindFirst: vi.fn(),
  stockBinCreate: vi.fn(),
  stockBinUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    warehouse: {
      findMany: mocks.warehouseFindMany,
      findFirst: mocks.warehouseFindFirst,
    },
    stockBin: { findFirst: mocks.stockBinFindFirst },
    $transaction: mocks.transaction,
  },
}));

import {
  createStockBin,
  createWarehouse,
  listWarehouses,
} from "@/lib/inventory/warehouses";

const warehouse = {
  id: "wh-1",
  siteId: "site-a",
  code: "MAIN",
  name: "Main warehouse",
  description: null,
  active: true,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

const bin = {
  id: "bin-1",
  warehouseId: "wh-1",
  code: "A-01",
  name: "Rack A / 01",
  description: null,
  active: true,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("inventory warehouses and bins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.warehouseFindMany.mockResolvedValue([]);
    mocks.warehouseFindFirst.mockResolvedValue({ id: "wh-1", active: true });
    mocks.stockBinFindFirst.mockResolvedValue(bin);
    mocks.warehouseCreate.mockResolvedValue(warehouse);
    mocks.warehouseUpdate.mockResolvedValue(warehouse);
    mocks.stockBinCreate.mockResolvedValue(bin);
    mocks.stockBinUpdate.mockResolvedValue(bin);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        warehouse: { create: mocks.warehouseCreate, update: mocks.warehouseUpdate },
        stockBin: { create: mocks.stockBinCreate, update: mocks.stockBinUpdate },
        auditLog: { create: mocks.auditCreate },
      }),
    );
  });

  it("rejects a site outside the organization before querying warehouses", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    await expect(
      listWarehouses({ organizationId: "org-b", siteId: "site-a" }),
    ).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });

    expect(mocks.warehouseFindMany).not.toHaveBeenCalled();
  });

  it("creates and audits a site-scoped warehouse", async () => {
    await createWarehouse({
      organizationId: "org-a",
      siteId: "site-a",
      code: "MAIN",
      name: "Main warehouse",
      actorId: "manager-1",
    });

    expect(mocks.warehouseCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ siteId: "site-a", code: "MAIN" }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "Warehouse",
        entityId: "wh-1",
        action: "CREATED",
      }),
    });
  });

  it("creates bins only inside a warehouse from the same site", async () => {
    await createStockBin({
      organizationId: "org-a",
      siteId: "site-a",
      warehouseId: "wh-1",
      code: "A-01",
      name: "Rack A / 01",
      actorId: "manager-1",
    });

    expect(mocks.warehouseFindFirst).toHaveBeenCalledWith({
      where: { id: "wh-1", siteId: "site-a" },
      select: { id: true, active: true },
    });
    expect(mocks.stockBinCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ warehouseId: "wh-1", code: "A-01" }),
    });
  });

  it("refuses a bin when the warehouse is not in the requested site", async () => {
    mocks.warehouseFindFirst.mockResolvedValue(null);

    await expect(
      createStockBin({
        organizationId: "org-a",
        siteId: "site-b",
        warehouseId: "wh-1",
        code: "A-01",
        name: "Rack A / 01",
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "WAREHOUSE_NOT_FOUND" });

    expect(mocks.stockBinCreate).not.toHaveBeenCalled();
  });
});
