import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  workOrderFindFirst: vi.fn(),
  workOrderUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  workOrder: {
    findFirst: mocks.workOrderFindFirst,
    update: mocks.workOrderUpdate,
  },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/db", () => ({
  db: { $transaction: mocks.transaction },
}));

import { rescheduleWorkOrder } from "@/lib/work-orders/reschedule";

function current(status = "PLANNED") {
  return {
    id: "wo-1",
    siteId: "site-a",
    status,
    plannedStart: new Date("2026-08-18T06:00:00.000Z"),
    dueAt: new Date("2026-08-18T10:00:00.000Z"),
  };
}

const input = {
  organizationId: "org-a",
  siteId: "site-a",
  workOrderId: "wo-1",
  plannedStart: new Date("2026-08-19T06:00:00.000Z"),
  dueAt: new Date("2026-08-19T10:00:00.000Z"),
  actorId: "manager-1",
};

describe("work-order rescheduling service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.workOrderFindFirst.mockResolvedValue(current());
    mocks.workOrderUpdate.mockResolvedValue({ ...current(), ...input });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("scopes the work order to tenant/site and records a RESCHEDULED audit event atomically", async () => {
    const result = await rescheduleWorkOrder(input);

    expect(result.changed).toBe(true);
    expect(mocks.workOrderFindFirst).toHaveBeenCalledWith({
      where: {
        id: "wo-1",
        siteId: "site-a",
        site: { organizationId: "org-a", active: true },
      },
    });
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: {
        plannedStart: input.plannedStart,
        dueAt: input.dueAt,
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "RESCHEDULED",
        beforeJson: expect.any(String),
        afterJson: expect.any(String),
      }),
    });
  });

  it.each(["COMPLETED", "CANCELLED"])("rejects %s work orders without changing history", async (status) => {
    mocks.workOrderFindFirst.mockResolvedValue(current(status));

    await expect(rescheduleWorkOrder(input)).rejects.toMatchObject({
      code: "WORK_ORDER_NOT_RESCHEDULABLE",
    });
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("treats an identical schedule as a no-op without creating audit noise", async () => {
    const same = current();
    mocks.workOrderFindFirst.mockResolvedValue(same);

    const result = await rescheduleWorkOrder({
      ...input,
      plannedStart: same.plannedStart,
      dueAt: same.dueAt,
    });

    expect(result).toEqual({ workOrder: same, changed: false });
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects invalid due dates before opening a transaction", async () => {
    await expect(
      rescheduleWorkOrder({
        ...input,
        dueAt: new Date("2026-08-19T05:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PLANNING" });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
