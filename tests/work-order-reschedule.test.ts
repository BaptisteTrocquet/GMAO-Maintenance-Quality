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

import { rescheduleWorkOrder } from "@/lib/maintenance/reschedule";

const input = {
  organizationId: "org-a",
  siteId: "site-a",
  workOrderId: "wo-1",
  plannedStart: new Date("2026-08-12T06:00:00.000Z"),
  actorId: "planner-1",
  reason: "Calendar drag-and-drop reschedule",
};

function current(status: "REQUESTED" | "APPROVED" | "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "COMPLETED" | "CANCELLED") {
  return {
    id: "wo-1",
    number: "WO-0001",
    status,
    plannedStart: status === "PLANNED" ? new Date("2026-08-10T06:00:00.000Z") : null,
    updatedAt: new Date("2026-08-08T00:00:00.000Z"),
  };
}

describe("work-order rescheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("promotes an approved work order to planned and records the schedule audit", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(current("APPROVED"));
    mocks.workOrderUpdate.mockResolvedValue({
      ...current("APPROVED"),
      status: "PLANNED",
      plannedStart: input.plannedStart,
    });

    const result = await rescheduleWorkOrder(input);

    expect(result.status).toBe("PLANNED");
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: { plannedStart: input.plannedStart, status: "PLANNED" },
      select: {
        id: true,
        number: true,
        status: true,
        plannedStart: true,
        updatedAt: true,
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        actorId: "planner-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "RESCHEDULED",
        beforeJson: JSON.stringify({ status: "APPROVED", plannedStart: null }),
        afterJson: JSON.stringify({
          status: "PLANNED",
          plannedStart: "2026-08-12T06:00:00.000Z",
          reason: "Calendar drag-and-drop reschedule",
        }),
      },
    });
  });

  it("moves an already planned work order without changing its workflow status", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(current("PLANNED"));
    mocks.workOrderUpdate.mockResolvedValue({
      ...current("PLANNED"),
      plannedStart: input.plannedStart,
    });

    await rescheduleWorkOrder(input);

    expect(mocks.workOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { plannedStart: input.plannedStart },
      }),
    );
  });

  it("requires approval before first scheduling", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(current("REQUESTED"));

    await expect(rescheduleWorkOrder(input)).rejects.toMatchObject({
      code: "SCHEDULING_REQUIRES_APPROVAL",
    });
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("keeps completed and cancelled work orders immutable", async () => {
    for (const status of ["COMPLETED", "CANCELLED"] as const) {
      vi.clearAllMocks();
      mocks.transaction.mockImplementation(
        async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
      );
      mocks.workOrderFindFirst.mockResolvedValue(current(status));

      await expect(rescheduleWorkOrder(input)).rejects.toMatchObject({
        code: "WORK_ORDER_NOT_RESCHEDULABLE",
      });
      expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    }
  });

  it("returns not found for a work order outside the selected site scope", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(null);

    await expect(rescheduleWorkOrder(input)).rejects.toMatchObject({
      code: "WORK_ORDER_NOT_FOUND",
    });
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });
});
