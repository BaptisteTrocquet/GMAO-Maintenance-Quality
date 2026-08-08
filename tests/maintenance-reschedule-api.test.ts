import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
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

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    $transaction: mocks.transaction,
  },
}));

import { PATCH } from "@/app/api/work-orders/[workOrderId]/reschedule/route";

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "MAINTENANCE_MANAGER" ? "manager-1" : "tech-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role,
        allSites: true,
        siteIds: [],
        active: true,
      },
    },
  };
}

const context = { params: Promise.resolve({ workOrderId: "wo-1" }) };

function request(targetDate = "2026-10-25") {
  return new Request("http://localhost/api/work-orders/wo-1/reschedule", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      targetDate,
    }),
  });
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("maintenance calendar rescheduling API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.siteFindFirst.mockResolvedValue({
      id: "site-a",
      organization: { timezone: "Europe/Paris" },
    });
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.workOrderFindFirst.mockResolvedValue({
      id: "wo-1",
      siteId: "site-a",
      status: "PLANNED",
      plannedStart: new Date("2026-10-23T06:30:00.000Z"),
      dueAt: new Date("2026-10-24T15:00:00.000Z"),
    });
    mocks.workOrderUpdate.mockImplementation(async ({ data }) => ({
      id: "wo-1",
      status: "PLANNED",
      ...data,
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("preserves local wall-clock planning through DST and audits in the same transaction", async () => {
    const response = await PATCH(request(), context);
    await expectStatus(response, 200);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: {
        plannedStart: new Date("2026-10-25T07:30:00.000Z"),
        dueAt: new Date("2026-10-26T16:00:00.000Z"),
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "RESCHEDULED",
        afterJson: expect.stringContaining('"targetDate":"2026-10-25"'),
      }),
    });
  });

  it("requires work:manage before reading or changing planning data", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await PATCH(request(), context);

    await expectStatus(response, 403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects completed work orders without writing planning history", async () => {
    mocks.workOrderFindFirst.mockResolvedValue({
      id: "wo-1",
      siteId: "site-a",
      status: "COMPLETED",
      plannedStart: new Date("2026-10-23T06:30:00.000Z"),
      dueAt: new Date("2026-10-24T15:00:00.000Z"),
    });

    const response = await PATCH(request(), context);

    await expectStatus(response, 409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("does not allow cross-site work orders to be rescheduled", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(null);

    const response = await PATCH(request(), context);

    await expectStatus(response, 404);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rolls back update and audit together when the transaction fails", async () => {
    mocks.auditCreate.mockRejectedValue(new Error("audit failed"));

    await expect(PATCH(request(), context)).rejects.toThrow("audit failed");
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.workOrderUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });
});
