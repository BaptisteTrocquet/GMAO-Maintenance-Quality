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
  db: {
    $transaction: mocks.transaction,
  },
}));

import { rescheduleWorkOrder } from "@/lib/work-orders/reschedule";

const current = {
  id: "wo-1",
  number: "WO-000001",
  siteId: "site-a",
  status: "PLANNED",
  plannedStart: new Date("2026-08-18T06:00:00.000Z"),
  dueAt: new Date("2026-08-18T14:00:00.000Z"),
};

const nextStart = new Date("2026-08-20T06:00:00.000Z");
const nextDue = new Date("2026-08-20T14:00:00.000Z");

describe("work-order rescheduling service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.workOrderFindFirst.mockResolvedValue(current);
    mocks.workOrderUpdate.mockResolvedValue({
      ...current,
      plannedStart: nextStart,
      dueAt: nextDue,
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("scopes the lookup to the active organization/site and audits before/after dates", async () => {
    const result = await rescheduleWorkOrder({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderId: "wo-1",
      plannedStart: nextStart,
      dueAt: nextDue,
      actorId: "manager-1",
    });

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
      data: { plannedStart: nextStart, dueAt: nextDue },
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
        afterJson: JSON.stringify({ plannedStart: nextStart, dueAt: nextDue }),
      },
    });
  });

  it("does not write or audit an identical schedule", async () => {
    const result = await rescheduleWorkOrder({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderId: "wo-1",
      plannedStart: current.plannedStart,
      dueAt: current.dueAt,
      actorId: "manager-1",
    });

    expect(result.changed).toBe(false);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("returns an opaque not-found error for work outside the selected tenant/site", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(null);

    await expect(
      rescheduleWorkOrder({
        organizationId: "org-a",
        siteId: "site-a",
        workOrderId: "wo-foreign",
        plannedStart: nextStart,
        dueAt: nextDue,
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "WORK_ORDER_NOT_FOUND" });
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects due dates earlier than planned start before opening a transaction", async () => {
    await expect(
      rescheduleWorkOrder({
        organizationId: "org-a",
        siteId: "site-a",
        workOrderId: "wo-1",
        plannedStart: nextStart,
        dueAt: new Date("2026-08-20T05:00:00.000Z"),
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PLANNING" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
