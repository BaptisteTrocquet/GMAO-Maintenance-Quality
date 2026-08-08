import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class WorkOrderRescheduleError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    rescheduleWorkOrder: vi.fn(),
    WorkOrderRescheduleError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/work-orders/reschedule", () => ({
  rescheduleWorkOrder: mocks.rescheduleWorkOrder,
  WorkOrderRescheduleError: mocks.WorkOrderRescheduleError,
}));

import { PATCH } from "@/app/api/work-orders/[workOrderId]/schedule/route";

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

function request(body: unknown) {
  return new Request("http://localhost/api/work-orders/wo-1/schedule", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ workOrderId: "wo-1" }) };
const validBody = {
  organizationId: "org-a",
  siteId: "site-a",
  plannedStart: "2026-08-11T06:00:00.000Z",
  dueAt: "2026-08-11T14:00:00.000Z",
};

describe("work-order rescheduling API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.rescheduleWorkOrder.mockResolvedValue({
      changed: true,
      workOrder: { id: "wo-1" },
    });
  });

  it("lets a maintenance manager reschedule through the transactional service", async () => {
    const response = await PATCH(request(validBody), context);

    expect(response.status).toBe(200);
    expect(mocks.rescheduleWorkOrder).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderId: "wo-1",
      plannedStart: new Date("2026-08-11T06:00:00.000Z"),
      dueAt: new Date("2026-08-11T14:00:00.000Z"),
      actorId: "manager-1",
    });
  });

  it("blocks technicians before the rescheduling service is called", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await PATCH(request(validBody), context);

    expect(response.status).toBe(403);
    expect(mocks.rescheduleWorkOrder).not.toHaveBeenCalled();
  });

  it("rejects malformed planning payloads", async () => {
    const response = await PATCH(
      request({ ...validBody, plannedStart: "not-a-date" }),
      context,
    );

    expect(response.status).toBe(400);
    expect(mocks.rescheduleWorkOrder).not.toHaveBeenCalled();
  });

  it("maps scoped not-found and closed-work conflicts without leaking records", async () => {
    mocks.rescheduleWorkOrder.mockRejectedValueOnce(
      new mocks.WorkOrderRescheduleError("WORK_ORDER_NOT_FOUND", "Not found"),
    );
    const missing = await PATCH(request(validBody), context);
    expect(missing.status).toBe(404);

    mocks.rescheduleWorkOrder.mockRejectedValueOnce(
      new mocks.WorkOrderRescheduleError(
        "WORK_ORDER_NOT_RESCHEDULABLE",
        "Completed work cannot move",
      ),
    );
    const closed = await PATCH(request(validBody), context);
    expect(closed.status).toBe(409);
  });

  it("maps impossible due/start ordering to a client error", async () => {
    mocks.rescheduleWorkOrder.mockRejectedValue(
      new mocks.WorkOrderRescheduleError("INVALID_PLANNING", "Invalid planning"),
    );

    const response = await PATCH(request(validBody), context);
    expect(response.status).toBe(400);
  });
});
