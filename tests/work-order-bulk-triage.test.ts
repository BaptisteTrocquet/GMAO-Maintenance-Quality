import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  workOrder: {
    findMany: mocks.findMany,
    update: mocks.update,
  },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
  },
}));

import { bulkTriageWorkOrders } from "@/lib/work-orders/bulk-triage";

const first = {
  id: "wo-1",
  number: "WO-001",
  priority: "NORMAL",
  plannedStart: new Date("2026-08-10T00:00:00.000Z"),
  dueAt: new Date("2026-08-12T00:00:00.000Z"),
};
const second = {
  id: "wo-2",
  number: "WO-002",
  priority: "LOW",
  plannedStart: null,
  dueAt: new Date("2026-08-15T00:00:00.000Z"),
};

describe("bulk work-order triage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.findMany.mockResolvedValue([first, second]);
    mocks.update.mockImplementation(async ({ where, data }) => ({
      ...(where.id === "wo-1" ? first : second),
      ...data,
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("updates every selected work order and audits each mutation in one transaction", async () => {
    const result = await bulkTriageWorkOrders({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderIds: ["wo-2", "wo-1"],
      changes: { priority: "HIGH", dueAt: new Date("2026-08-20T00:00:00.000Z") },
      actorId: "manager-1",
    });

    expect(result).toEqual({ updatedIds: ["wo-1", "wo-2"], count: 2 });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["wo-1", "wo-2"] },
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
        },
      }),
    );
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: "manager-1",
          entityType: "WorkOrder",
          entityId: "wo-1",
          action: "BULK_TRIAGED",
        }),
      }),
    );
  });

  it("rejects the whole operation when any selected id is outside the site scope", async () => {
    mocks.findMany.mockResolvedValue([first]);

    await expect(
      bulkTriageWorkOrders({
        organizationId: "org-a",
        siteId: "site-a",
        workOrderIds: ["wo-1", "wo-other-site"],
        changes: { priority: "URGENT" },
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "WORK_ORDER_NOT_FOUND" });

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a bulk date change when it would invalidate any work-order planning window", async () => {
    await expect(
      bulkTriageWorkOrders({
        organizationId: "org-a",
        siteId: "site-a",
        workOrderIds: ["wo-1", "wo-2"],
        changes: { dueAt: new Date("2026-08-09T00:00:00.000Z") },
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PLANNING" });

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
