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

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));
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

function request(targetDate = "2026-08-12") {
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

const current = {
  id: "wo-1",
  siteId: "site-a",
  status: "PLANNED",
  plannedStart: new Date("2026-08-10T06:00:00.000Z"),
  dueAt: new Date("2026-08-10T14:00:00.000Z"),
};

describe("atomic calendar rescheduling API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.siteFindFirst.mockResolvedValue({
      organization: { timezone: "Europe/Paris" },
    });
    mocks.transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.workOrderFindFirst.mockResolvedValue(current);
    mocks.workOrderUpdate.mockImplementation(
      async ({ data }: { data: { plannedStart: Date; dueAt: Date | null } }) => ({
        ...current,
        ...data,
      }),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("updates and audits the reschedule in one serializable transaction", async () => {
    const response = await PATCH(request(), context);

    expect(response.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
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
        plannedStart: new Date("2026-08-12T06:00:00.000Z"),
        dueAt: new Date("2026-08-12T14:00:00.000Z"),
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "RESCHEDULED",
        beforeJson: expect.any(String),
        afterJson: expect.stringContaining('"targetDate":"2026-08-12"'),
      }),
    });
    expect(mocks.workOrderUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.auditCreate.mock.invocationCallOrder[0],
    );
  });

  it("blocks technicians before site lookup or transaction writes", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await PATCH(request(), context);

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("returns an opaque not-found for a work order outside tenant/site scope", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(null);

    const response = await PATCH(request(), context);

    expect(response.status).toBe(404);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "CANCELLED"])("rejects %s work orders without history changes", async (status) => {
    mocks.workOrderFindFirst.mockResolvedValue({ ...current, status });

    const response = await PATCH(request(), context);

    expect(response.status).toBe(409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects invalid target date formats before authentication", async () => {
    const response = await PATCH(request("2026-2-31"), context);

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
