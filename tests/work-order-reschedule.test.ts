import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  workOrder: {
    findFirst: mocks.findFirst,
    update: mocks.update,
  },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/db", () => ({
  db: { $transaction: mocks.transaction },
}));

import { rescheduleWorkOrder } from "@/lib/work-orders/reschedule";

const current = {
  id: "wo-1",
  number: "WO-001",
  siteId: "site-a",
  status: "PLANNED",
  plannedStart: new Date("2026-08-10T06:00:00.000Z"),
  dueAt: new Date("2026-08-10T14:00:00.000Z"),
};

const input = {
  organizationId: "org-a",
  siteId: "site-a",
  workOrderId: "wo-1",
  plannedStart: new Date("2026-08-11T06:00:00.000Z"),
  dueAt: new Date("2026-08-11T14:00:00.000Z"),
  actorId: "manager-1",
};

describe("transactional work-order rescheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.findFirst.mockResolvedValue(current);
    mocks.update.mockResolvedValue({
      ...current,
      plannedStart: input.plannedStart,
      dueAt: input.dueAt,
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("updates schedule and writes RESCHEDULED audit inside one transaction", async () => {
    const result = await rescheduleWorkOrder(input);

    expect(result.changed).toBe(true);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        id: "wo-1",
        siteId: "site-a",
        site: { organizationId: "org-a", active: true },
      },
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: {
        plannedStart: input.plannedStart,
        dueAt: input.dueAt,
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "RESCHEDULED",
        beforeJson: JSON.stringify({
          plannedStart: current.plannedStart,
          dueAt: current.dueAt,
        }),
        afterJson: JSON.stringify({
          plannedStart: input.plannedStart,
          dueAt: input.dueAt,
        }),
      },
    });
  });

  it("does not write a duplicate audit when the schedule is unchanged", async () => {
    const result = await rescheduleWorkOrder({
      ...input,
      plannedStart: current.plannedStart,
      dueAt: current.dueAt,
    });

    expect(result.changed).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects completed work orders before update or audit", async () => {
    mocks.findFirst.mockResolvedValue({ ...current, status: "COMPLETED" });

    await expect(rescheduleWorkOrder(input)).rejects.toMatchObject({
      code: "WORK_ORDER_NOT_RESCHEDULABLE",
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects due dates earlier than the new planned start before opening a transaction", async () => {
    await expect(
      rescheduleWorkOrder({
        ...input,
        plannedStart: new Date("2026-08-11T14:00:00.000Z"),
        dueAt: new Date("2026-08-11T06:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PLANNING" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("returns a tenant-safe not-found when the work order is outside site scope", async () => {
    mocks.findFirst.mockResolvedValue(null);

    await expect(rescheduleWorkOrder(input)).rejects.toMatchObject({
      code: "WORK_ORDER_NOT_FOUND",
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
