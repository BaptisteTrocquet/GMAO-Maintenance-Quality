import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  dbSupplierFindFirst: vi.fn(),
  supplierFindFirst: vi.fn(),
  supplierFindUnique: vi.fn(),
  supplierCreate: vi.fn(),
  supplierUpdate: vi.fn(),
  partFindFirst: vi.fn(),
  partSupplierFindUnique: vi.fn(),
  partSupplierUpdateMany: vi.fn(),
  partSupplierUpsert: vi.fn(),
  partSupplierUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  supplier: {
    findFirst: mocks.supplierFindFirst,
    findUnique: mocks.supplierFindUnique,
    create: mocks.supplierCreate,
    update: mocks.supplierUpdate,
  },
  part: { findFirst: mocks.partFindFirst },
  partSupplier: {
    findUnique: mocks.partSupplierFindUnique,
    updateMany: mocks.partSupplierUpdateMany,
    upsert: mocks.partSupplierUpsert,
    update: mocks.partSupplierUpdate,
  },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    supplier: { findFirst: mocks.dbSupplierFindFirst },
    $transaction: mocks.transaction,
  },
}));

import {
  setPartSupplierReference,
  updateSupplier,
} from "@/lib/inventory/suppliers";

const supplier = {
  id: "supplier-1",
  organizationId: "org-a",
  code: "SUP-001",
  name: "Demo Industrial Supply",
  contactName: null,
  email: null,
  phone: null,
  website: null,
  active: true,
  createdAt: new Date("2026-08-08T00:00:00.000Z"),
  updatedAt: new Date("2026-08-08T00:00:00.000Z"),
};

const reference = {
  partId: "part-1",
  supplierId: "supplier-1",
  supplierPartNumber: "SUP-SP-001",
  preferred: true,
  leadTimeDays: 7,
  minOrderQuantity: 2,
  unitCost: null,
  currency: "EUR",
  active: true,
  createdAt: new Date("2026-08-08T00:00:00.000Z"),
  updatedAt: new Date("2026-08-08T00:00:00.000Z"),
};

describe("inventory supplier references", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.dbSupplierFindFirst.mockResolvedValue(supplier);
    mocks.supplierFindFirst.mockResolvedValue({ id: "supplier-1", active: true });
    mocks.supplierFindUnique.mockResolvedValue(null);
    mocks.supplierCreate.mockResolvedValue(supplier);
    mocks.supplierUpdate.mockResolvedValue(supplier);
    mocks.partFindFirst.mockResolvedValue({ id: "part-1" });
    mocks.partSupplierFindUnique.mockResolvedValue(null);
    mocks.partSupplierUpdateMany.mockResolvedValue({ count: 0 });
    mocks.partSupplierUpsert.mockResolvedValue(reference);
    mocks.partSupplierUpdate.mockResolvedValue({ ...reference, active: false, preferred: false });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("makes a preferred reference exclusive for the part", async () => {
    const result = await setPartSupplierReference({
      organizationId: "org-a",
      partId: "part-1",
      supplierId: "supplier-1",
      supplierPartNumber: "SUP-SP-001",
      preferred: true,
      leadTimeDays: 7,
      minOrderQuantity: 2,
      actorId: "manager-1",
    });

    expect(result.preferred).toBe(true);
    expect(mocks.partSupplierUpdateMany).toHaveBeenCalledWith({
      where: {
        partId: "part-1",
        preferred: true,
        active: true,
        NOT: { supplierId: "supplier-1" },
      },
      data: { preferred: false },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "PartSupplier",
        entityId: "part-1:supplier-1",
        action: "CREATED",
      }),
    });
  });

  it("rejects references to a supplier from another organization", async () => {
    mocks.supplierFindFirst.mockResolvedValue(null);
    mocks.supplierFindUnique.mockResolvedValue({ organizationId: "org-b" });

    await expect(
      setPartSupplierReference({
        organizationId: "org-a",
        partId: "part-1",
        supplierId: "supplier-2",
        supplierPartNumber: "OTHER-001",
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "CROSS_ORGANIZATION_REFERENCE" });

    expect(mocks.partSupplierUpsert).not.toHaveBeenCalled();
  });

  it("rejects references when the part is outside the organization", async () => {
    mocks.partFindFirst.mockResolvedValue(null);

    await expect(
      setPartSupplierReference({
        organizationId: "org-a",
        partId: "part-outside",
        supplierId: "supplier-1",
        supplierPartNumber: "SUP-SP-001",
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "PART_NOT_FOUND" });

    expect(mocks.partSupplierUpsert).not.toHaveBeenCalled();
  });

  it("deactivates all active references when a supplier is archived", async () => {
    mocks.dbSupplierFindFirst.mockResolvedValue(supplier);
    mocks.supplierUpdate.mockResolvedValue({ ...supplier, active: false });

    await updateSupplier({
      organizationId: "org-a",
      supplierId: "supplier-1",
      patch: { active: false },
      actorId: "manager-1",
    });

    expect(mocks.partSupplierUpdateMany).toHaveBeenCalledWith({
      where: { supplierId: "supplier-1", active: true },
      data: { active: false, preferred: false },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "Supplier",
        entityId: "supplier-1",
        action: "ARCHIVED",
      }),
    });
  });
});
