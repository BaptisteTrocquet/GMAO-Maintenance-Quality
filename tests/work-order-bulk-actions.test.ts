import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  workFindMany: vi.fn(),
  workUpdate: vi.fn(),
  auditCreate: vi.fn(),
  membershipFindFirst: vi.fn(),
  teamFindFirst: vi.fn(),
}));

const tx = {
  workOrder: { findMany: mocks.workFindMany, update: mocks.workUpdate },
  auditLog: { create: mocks.auditCreate },
  organizationMembership: { findFirst: mocks.membershipFindFirst },
  maintenanceTeam: { findFirst: mocks.teamFindFirst },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    workOrder: { findMany: vi.fn() },
    maintenanceTeam: { findMany: vi.fn() },
    organizationMembership: { findMany: vi.fn() },
  },
}));

import { BULK_WORK_ORDER_LIMIT, bulkTriageWorkOrders } from "@/lib/work-orders/bulk-actions";

const workOrders = [
  { id: "wo-1", number: "WO-001", siteId: "site-a", priority: "NORMAL" },
  { id: "wo-2", number: "WO-002", siteId: "site-a", priority: "NORMAL" },
];

describe("work-order bulk actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
    mocks.workFindMany.mockResolvedValue(workOrders);
    mocks.workUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      ...workOrders.find((workOrder) => workOrder.id === where.id),
      ...data,
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit" });
    mocks.membershipFindFirst.mockResolvedValue({ id: "membership-1" });
    mocks.teamFindFirst.mockResolvedValue({ id: "team-1" });
  });

  it("updates and audits every selected work order in the same transaction", async () => {
    const result = await bulkTriageWorkOrders({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderIds: ["wo-1", "wo-2", "wo-1"],
      operation: { type: "SET_PRIORITY", priority: "HIGH" },
      actorId: "manager-1",
    });

    expect(result.count).toBe(2);
    expect(mocks.workFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: { in: ["wo-1", "wo-2"] },
        siteId: "site-a",
        site: { organizationId: "org-a", active: true },
      },
    }));
    expect(mocks.workUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "BULK_TRIAGED",
      }),
    });
  });

  it("fails the entire batch before writes when any work order is outside scope", async () => {
    mocks.workFindMany.mockResolvedValue([workOrders[0]]);

    await expect(
      bulkTriageWorkOrders({
        organizationId: "org-a",
        siteId: "site-a",
        workOrderIds: ["wo-1", "wo-foreign"],
        operation: { type: "SET_PRIORITY", priority: "URGENT" },
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "WORK_ORDER_SCOPE_MISMATCH" });

    expect(mocks.workUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("validates an assignee before the first work-order write", async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(
      bulkTriageWorkOrders({
        organizationId: "org-a",
        siteId: "site-a",
        workOrderIds: ["wo-1", "wo-2"],
        operation: { type: "SET_ASSIGNEE", assigneeId: "external-user" },
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "ASSIGNEE_NOT_FOUND" });

    expect(mocks.workUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects batches above the safety limit before opening a transaction", async () => {
    await expect(
      bulkTriageWorkOrders({
        organizationId: "org-a",
        siteId: "site-a",
        workOrderIds: Array.from({ length: BULK_WORK_ORDER_LIMIT + 1 }, (_, index) => `wo-${index}`),
        operation: { type: "SET_TEAM", teamId: null },
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({ code: "BATCH_TOO_LARGE" });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});