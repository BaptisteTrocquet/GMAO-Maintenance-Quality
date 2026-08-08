import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  supplierFindFirst: vi.fn(),
  supplierFindUnique: vi.fn(),
  partFindFirst: vi.fn(),
  referenceFindUnique: vi.fn(),
  referenceUpdateMany: vi.fn(),
  referenceUpsert: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  supplier: {
    findFirst: mocks.supplierFindFirst,
    findUnique: mocks.supplierFindUnique,
  },
  part: { findFirst: mocks.partFindFirst },
  partSupplier: {
    findUnique: mocks.referenceFindUnique,
    updateMany: mocks.referenceUpdateMany,
    upsert: mocks.referenceUpsert,
  },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
  },
}));

import { setPartSupplierReference } from "@/lib/inventory/suppliers";

describe("supplier reference nullable fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.partFindFirst.mockResolvedValue({ id: "part-1" });
    mocks.supplierFindFirst.mockResolvedValue({ id: "supplier-1", active: true });
    mocks.supplierFindUnique.mockResolvedValue(null);
    mocks.referenceFindUnique.mockResolvedValue({
      partId: "part-1",
      supplierId: "supplier-1",
      supplierPartNumber: "SUP-SP-001",
      preferred: false,
      leadTimeDays: 7,
      minOrderQuantity: 3,
      unitCost: { toString: () => "12.50" },
      currency: "EUR",
      active: true,
    });
    mocks.referenceUpdateMany.mockResolvedValue({ count: 0 });
    mocks.referenceUpsert.mockResolvedValue({
      partId: "part-1",
      supplierId: "supplier-1",
      supplierPartNumber: "SUP-SP-001",
      preferred: false,
      leadTimeDays: null,
      minOrderQuantity: null,
      unitCost: null,
      currency: "EUR",
      active: true,
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("persists explicit nulls instead of restoring previous optional values", async () => {
    await setPartSupplierReference({
      organizationId: "org-a",
      partId: "part-1",
      supplierId: "supplier-1",
      supplierPartNumber: "SUP-SP-001",
      leadTimeDays: null,
      minOrderQuantity: null,
      unitCost: null,
      actorId: "manager-1",
    });

    expect(mocks.referenceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          leadTimeDays: null,
          minOrderQuantity: null,
          unitCost: null,
        }),
      }),
    );
  });
});
