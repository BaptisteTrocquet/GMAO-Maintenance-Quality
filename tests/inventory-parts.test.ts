import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  partFindMany: vi.fn(),
  partFindFirst: vi.fn(),
  partCreate: vi.fn(),
  partUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    part: {
      findMany: mocks.partFindMany,
      findFirst: mocks.partFindFirst,
    },
    $transaction: mocks.transaction,
  },
}));

import { createPart, listParts, updatePart } from "@/lib/inventory/parts";

const currentPart = {
  id: "part-1",
  organizationId: "org-a",
  sku: "SP-001",
  name: "Seal kit",
  description: null,
  unit: "EA",
  quantityOnHand: 4,
  reorderPoint: 1,
  unitCost: null,
  active: true,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("inventory part master", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.partFindMany.mockResolvedValue([]);
    mocks.partFindFirst.mockResolvedValue(currentPart);
    mocks.partCreate.mockResolvedValue(currentPart);
    mocks.partUpdate.mockResolvedValue(currentPart);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        part: { create: mocks.partCreate, update: mocks.partUpdate },
        auditLog: { create: mocks.auditCreate },
      }),
    );
  });

  it("lists only active parts inside the requested organization by default", async () => {
    await listParts({ organizationId: "org-a" });

    expect(mocks.partFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-a", active: true },
      }),
    );
  });

  it("creates master data without allowing direct stock initialization", async () => {
    await createPart({
      organizationId: "org-a",
      sku: "SP-001",
      name: "Seal kit",
      reorderPoint: 1,
      actorId: "manager-1",
    });

    const data = mocks.partCreate.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      organizationId: "org-a",
      sku: "SP-001",
      name: "Seal kit",
      reorderPoint: 1,
    });
    expect(data).not.toHaveProperty("quantityOnHand");
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "Part",
        entityId: "part-1",
        action: "CREATED",
      }),
    });
  });

  it("refuses to update a part outside the organization scope", async () => {
    mocks.partFindFirst.mockResolvedValue(null);

    await expect(
      updatePart({
        organizationId: "org-b",
        partId: "part-1",
        patch: { name: "Other" },
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "PART_NOT_FOUND" });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("records soft archive as an explicit audit event", async () => {
    mocks.partUpdate.mockResolvedValue({ ...currentPart, active: false });

    await updatePart({
      organizationId: "org-a",
      partId: "part-1",
      patch: { active: false },
      actorId: "manager-1",
    });

    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "Part",
        entityId: "part-1",
        action: "ARCHIVED",
      }),
    });
  });
});
