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

function request(targetDateKey = "2026-10-26") {
  return new Request("http://localhost/api/work-orders/wo-1/reschedule", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      targetDateKey,
    }),
  });
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
      plannedStart: new Date("2026-10-24T06:15:00.000Z"),
      dueAt: new Date("2026-10-30T16:00:00.000Z"),
    });
    mocks.workOrderUpdate.mockImplementation(async ({ data }) => ({
      id: "wo-1",
      status: "PLANNED",
      dueAt: new Date("2026-10-30T16:00:00.000Z"),
      ...data,
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("moves plannedStart in site timezone, preserves dueAt and audits inside one transaction", async () => {
    const response = await PATCH(request(), context);
    expect(response.status).toBe(200);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: { plannedStart: new Date("2026-10-26T07:15:00.000Z") },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "RESCHEDULED",
        beforeJson: expect.stringContaining('"dueAt":"2026-10-30T16:00:00.000Z"'),
        afterJson: expect.stringContaining('"targetDateKey":"2026-10-26"'),
      }),
    });
  });

  it("requires work:manage before reading scoped planning data", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await PATCH(request(), context);

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects cross-site work orders without update or audit", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(null);

    const response = await PATCH(request(), context);

    expect(response.status).toBe(404);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects completed or cancelled work orders", async () => {
    for (const status of ["COMPLETED", "CANCELLED"] as const) {
      mocks.workOrderFindFirst.mockResolvedValue({
        id: "wo-1",
        siteId: "site-a",
        status,
        plannedStart: new Date("2026-10-24T06:15:00.000Z"),
        dueAt: new Date("2026-10-30T16:00:00.000Z"),
      });

      const response = await PATCH(request(), context);
      expect(response.status).toBe(409);
    }
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses a move after the existing due date instead of silently shifting the deadline", async () => {
    mocks.workOrderFindFirst.mockResolvedValue({
      id: "wo-1",
      siteId: "site-a",
      status: "PLANNED",
      plannedStart: new Date("2026-10-24T06:15:00.000Z"),
      dueAt: new Date("2026-10-25T12:00:00.000Z"),
    });

    const response = await PATCH(request("2026-10-26"), context);

    expect(response.status).toBe(409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});