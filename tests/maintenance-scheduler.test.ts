import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  siteFindFirst: vi.fn(),
  planFindMany: vi.fn(),
  workOrderFindUnique: vi.fn(),
  planUpdateMany: vi.fn(),
  transaction: vi.fn(),
  txWorkOrderCreate: vi.fn(),
  txPlanUpdateMany: vi.fn(),
  txAuditCreate: vi.fn(),
}));

const tx = {
  workOrder: { create: mocks.txWorkOrderCreate },
  maintenancePlan: { updateMany: mocks.txPlanUpdateMany },
  auditLog: { create: mocks.txAuditCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    maintenancePlan: { findMany: mocks.planFindMany, updateMany: mocks.planUpdateMany },
    workOrder: { findUnique: mocks.workOrderFindUnique },
    $transaction: mocks.transaction,
  },
}));

import {
  generateCalendarMaintenanceWorkOrders,
  preventiveWorkOrderNumber,
} from "@/lib/maintenance/scheduler";

function plan(name = "Monthly inspection") {
  return {
    id: "plan-1",
    assetId: "asset-1",
    name,
    description: "Synthetic preventive task.",
    frequencyValue: 1,
    frequencyUnit: "MONTH",
    nextDueAt: new Date("2026-08-01T06:00:00.000Z"),
    active: true,
    estimatedMinutes: 30,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    asset: { siteId: "site-a" },
    checklistItems: [
      { id: "item-1", maintenancePlanId: "plan-1", sequence: 1, label: "Inspect guard", mandatory: true },
      { id: "item-2", maintenancePlanId: "plan-1", sequence: 2, label: "Record condition", mandatory: false },
    ],
  };
}

const throughDate = new Date("2026-08-01T23:59:59.000Z");

describe("preventive maintenance scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a", organization: { timezone: "Europe/Paris" } });
    mocks.planFindMany.mockResolvedValue([plan()]);
    mocks.workOrderFindUnique.mockResolvedValue(null);
    mocks.txWorkOrderCreate.mockImplementation(async ({ data }: { data: { number: string } }) => ({
      id: "wo-1",
      number: data.number,
      checkItems: [],
    }));
    mocks.txPlanUpdateMany.mockResolvedValue({ count: 1 });
    mocks.planUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txAuditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
  });

  it("builds a deterministic globally unique work-order number from plan and due occurrence", () => {
    const dueAt = new Date("2026-08-01T06:00:00.000Z");
    expect(preventiveWorkOrderNumber("plan-1", dueAt)).toBe(
      preventiveWorkOrderNumber("plan-1", dueAt),
    );
    expect(preventiveWorkOrderNumber("plan-1", dueAt)).not.toBe(
      preventiveWorkOrderNumber("plan-2", dueAt),
    );
  });

  it("generates an approved preventive work order and advances next due atomically", async () => {
    const result = await generateCalendarMaintenanceWorkOrders({
      organizationId: "org-a",
      siteId: "site-a",
      throughDate,
      actorId: "manager-1",
    });

    expect(result.generated).toHaveLength(1);
    expect(result.existing).toHaveLength(0);
    expect(mocks.txWorkOrderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        siteId: "site-a",
        assetId: "asset-1",
        title: "PM: Monthly inspection",
        type: "PREVENTIVE",
        status: "APPROVED",
        priority: "NORMAL",
        dueAt: new Date("2026-08-01T06:00:00.000Z"),
        checkItems: {
          create: [
            { label: "Inspect guard", completed: false },
            { label: "[Optional] Record condition", completed: false },
          ],
        },
      }),
      include: { checkItems: true },
    });
    expect(mocks.txPlanUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "plan-1",
        active: true,
        nextDueAt: new Date("2026-08-01T06:00:00.000Z"),
      },
      data: { nextDueAt: new Date("2026-09-01T06:00:00.000Z") },
    });
    expect(mocks.txAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "WorkOrder",
        action: "PREVENTIVE_GENERATED",
      }),
    });
  });

  it("does not create a duplicate work order when the scheduler repeats the same occurrence", async () => {
    const generatedNumber = preventiveWorkOrderNumber(
      "plan-1",
      new Date("2026-08-01T06:00:00.000Z"),
    );
    mocks.planFindMany.mockResolvedValue([plan()]);
    mocks.workOrderFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "wo-1", number: generatedNumber });

    const first = await generateCalendarMaintenanceWorkOrders({
      organizationId: "org-a",
      siteId: "site-a",
      throughDate,
    });
    const second = await generateCalendarMaintenanceWorkOrders({
      organizationId: "org-a",
      siteId: "site-a",
      throughDate,
    });

    expect(first.generated).toHaveLength(1);
    expect(second.generated).toHaveLength(0);
    expect(second.existing).toEqual([{ id: "wo-1", number: generatedNumber }]);
    expect(mocks.txWorkOrderCreate).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite an existing historical work order when the plan template later changes", async () => {
    const generatedNumber = preventiveWorkOrderNumber(
      "plan-1",
      new Date("2026-08-01T06:00:00.000Z"),
    );
    mocks.planFindMany
      .mockResolvedValueOnce([plan("Original template")])
      .mockResolvedValueOnce([plan("Renamed template")]);
    mocks.workOrderFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "wo-1", number: generatedNumber, title: "PM: Original template" });

    await generateCalendarMaintenanceWorkOrders({
      organizationId: "org-a",
      siteId: "site-a",
      throughDate,
    });
    await generateCalendarMaintenanceWorkOrders({
      organizationId: "org-a",
      siteId: "site-a",
      throughDate,
    });

    expect(mocks.txWorkOrderCreate).toHaveBeenCalledTimes(1);
    const generatedAudit = mocks.txAuditCreate.mock.calls.find(
      (call) => call[0]?.data?.action === "PREVENTIVE_GENERATED",
    )?.[0]?.data;
    const snapshot = JSON.parse(generatedAudit.afterJson) as {
      planSnapshot: { name: string };
    };
    expect(snapshot.planSnapshot.name).toBe("Original template");
  });
});
