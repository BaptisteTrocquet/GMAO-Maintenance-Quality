import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  meterFindFirst: vi.fn(),
  planFindMany: vi.fn(),
  planUpdateMany: vi.fn(),
  workOrderFindUnique: vi.fn(),
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
    meter: { findFirst: mocks.meterFindFirst },
    maintenancePlan: { findMany: mocks.planFindMany, updateMany: mocks.planUpdateMany },
    workOrder: { findUnique: mocks.workOrderFindUnique },
    $transaction: mocks.transaction,
  },
}));

import {
  generateMeterMaintenanceWorkOrders,
  meterPreventiveWorkOrderNumber,
} from "@/lib/maintenance/meter-scheduler";

function plan(nextDueMeterValue = 100) {
  return {
    id: "plan-meter-1",
    assetId: "asset-1",
    meterId: "meter-1",
    name: "Operating-hours inspection",
    description: "Synthetic meter-based preventive task.",
    frequencyValue: 100,
    frequencyUnit: "METER",
    nextDueAt: null,
    nextDueMeterValue,
    active: true,
    estimatedMinutes: 20,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    asset: { siteId: "site-a" },
    meter: {
      id: "meter-1",
      code: "HOURS",
      name: "Operating hours",
      unit: "h",
      allowRollover: false,
    },
    checklistItems: [
      { id: "item-1", maintenancePlanId: "plan-meter-1", sequence: 1, label: "Inspect belt", mandatory: true },
      { id: "item-2", maintenancePlanId: "plan-meter-1", sequence: 2, label: "Record wear", mandatory: false },
    ],
  };
}

const readingAt = new Date("2026-08-07T12:00:00.000Z");

describe("meter preventive maintenance scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.meterFindFirst.mockResolvedValue({ id: "meter-1", allowRollover: false });
    mocks.planFindMany.mockResolvedValue([plan()]);
    mocks.workOrderFindUnique.mockResolvedValue(null);
    mocks.txWorkOrderCreate.mockImplementation(async ({ data }: { data: { number: string } }) => ({
      id: `wo-${data.number}`,
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

  it("builds a deterministic number from plan and meter threshold", () => {
    expect(meterPreventiveWorkOrderNumber("plan-1", 100)).toBe(
      meterPreventiveWorkOrderNumber("plan-1", 100),
    );
    expect(meterPreventiveWorkOrderNumber("plan-1", 100)).not.toBe(
      meterPreventiveWorkOrderNumber("plan-1", 200),
    );
  });

  it("generates a preventive work order at the crossed threshold and advances atomically", async () => {
    const result = await generateMeterMaintenanceWorkOrders({
      siteId: "site-a",
      meterId: "meter-1",
      readingValue: 125,
      readingAt,
      actorId: "technician-1",
    });

    expect(result.generated).toHaveLength(1);
    expect(result.generated[0]?.threshold).toBe(100);
    expect(mocks.txWorkOrderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        siteId: "site-a",
        assetId: "asset-1",
        title: "PM: Operating-hours inspection",
        type: "PREVENTIVE",
        status: "APPROVED",
        dueAt: readingAt,
        checkItems: {
          create: [
            { label: "Inspect belt", completed: false },
            { label: "[Optional] Record wear", completed: false },
          ],
        },
      }),
      include: { checkItems: true },
    });
    expect(mocks.txPlanUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "plan-meter-1",
        active: true,
        frequencyUnit: "METER",
        meterId: "meter-1",
        nextDueMeterValue: 100,
      },
      data: { nextDueMeterValue: 200 },
    });
  });

  it("catches up every crossed threshold when a reading jumps forward", async () => {
    const result = await generateMeterMaintenanceWorkOrders({
      siteId: "site-a",
      meterId: "meter-1",
      readingValue: 350,
      readingAt,
    });

    expect(result.generated.map((item) => item.threshold)).toEqual([100, 200, 300]);
    expect(mocks.txWorkOrderCreate).toHaveBeenCalledTimes(3);
    expect(mocks.txPlanUpdateMany).toHaveBeenNthCalledWith(3, {
      where: {
        id: "plan-meter-1",
        active: true,
        frequencyUnit: "METER",
        meterId: "meter-1",
        nextDueMeterValue: 300,
      },
      data: { nextDueMeterValue: 400 },
    });
  });

  it("does not double-trigger the same threshold on a repeated reading", async () => {
    const number = meterPreventiveWorkOrderNumber("plan-meter-1", 100);
    mocks.planFindMany.mockResolvedValue([plan()]);
    mocks.workOrderFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "wo-existing", number });

    const first = await generateMeterMaintenanceWorkOrders({
      siteId: "site-a",
      meterId: "meter-1",
      readingValue: 125,
      readingAt,
    });
    const second = await generateMeterMaintenanceWorkOrders({
      siteId: "site-a",
      meterId: "meter-1",
      readingValue: 125,
      readingAt,
    });

    expect(first.generated).toHaveLength(1);
    expect(second.generated).toHaveLength(0);
    expect(second.existing).toEqual([{ id: "wo-existing", number, threshold: 100 }]);
    expect(mocks.txWorkOrderCreate).toHaveBeenCalledTimes(1);
  });

  it("recovers a concurrent unique-number race without a second work order", async () => {
    const number = meterPreventiveWorkOrderNumber("plan-meter-1", 100);
    mocks.workOrderFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "wo-raced", number });
    mocks.transaction.mockRejectedValueOnce(new Error("unique constraint"));

    const result = await generateMeterMaintenanceWorkOrders({
      siteId: "site-a",
      meterId: "meter-1",
      readingValue: 125,
      readingAt,
    });

    expect(result.generated).toHaveLength(0);
    expect(result.existing).toEqual([{ id: "wo-raced", number, threshold: 100 }]);
    expect(mocks.planUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "plan-meter-1",
        active: true,
        frequencyUnit: "METER",
        meterId: "meter-1",
        nextDueMeterValue: 100,
      },
      data: { nextDueMeterValue: 200 },
    });
  });

  it("keeps rollover meters working when no recurrence plan is configured", async () => {
    mocks.meterFindFirst.mockResolvedValue({ id: "meter-1", allowRollover: true });
    mocks.planFindMany.mockResolvedValue([]);

    const result = await generateMeterMaintenanceWorkOrders({
      siteId: "site-a",
      meterId: "meter-1",
      readingValue: 12,
      readingAt,
    });

    expect(result).toEqual({ meterFound: true, generated: [], existing: [] });
  });
});
