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

function request() {
  return new Request("http://localhost/api/work-orders/wo-1/schedule", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      plannedStart: "2026-08-19T06:00:00.000Z",
      dueAt: "2026-08-19T10:00:00.000Z",
    }),
  });
}

const context = { params: Promise.resolve({ workOrderId: "wo-1" }) };

function expectResponse(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
  return response;
}

describe("calendar work-order rescheduling API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.rescheduleWorkOrder.mockResolvedValue({
      changed: true,
      workOrder: { id: "wo-1", plannedStart: new Date("2026-08-19T06:00:00.000Z") },
    });
  });

  it("requires work:manage and forwards tenant/site scope plus actor identity", async () => {
    const response = expectResponse(await PATCH(request(), context), 200);

    expect(mocks.rescheduleWorkOrder).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderId: "wo-1",
      plannedStart: new Date("2026-08-19T06:00:00.000Z"),
      dueAt: new Date("2026-08-19T10:00:00.000Z"),
      actorId: "manager-1",
    });
    await expect(response.json()).resolves.toMatchObject({ data: { changed: true } });
  });

  it("blocks technicians from calendar rescheduling before the service is called", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = expectResponse(await PATCH(request(), context), 403);

    expect(mocks.rescheduleWorkOrder).not.toHaveBeenCalled();
  });

  it("maps completed/cancelled work-order protection to a workflow conflict", async () => {
    mocks.rescheduleWorkOrder.mockRejectedValue(
      new mocks.WorkOrderRescheduleError(
        "WORK_ORDER_NOT_RESCHEDULABLE",
        "Completed or cancelled work orders cannot be rescheduled",
      ),
    );

    const response = expectResponse(await PATCH(request(), context), 409);

    await expect(response.json()).resolves.toMatchObject({
      error: { code: "WORK_ORDER_NOT_RESCHEDULABLE" },
    });
  });

  it("returns opaque 404 for work orders outside the selected scope", async () => {
    mocks.rescheduleWorkOrder.mockRejectedValue(
      new mocks.WorkOrderRescheduleError(
        "WORK_ORDER_NOT_FOUND",
        "Work order not found in site scope",
      ),
    );

    const response = expectResponse(await PATCH(request(), context), 404);

    await expect(response.json()).resolves.toMatchObject({
      error: { code: "WORK_ORDER_NOT_FOUND" },
    });
  });

  it("rejects malformed JSON before authentication or writes", async () => {
    const response = expectResponse(
      await PATCH(
        new Request("http://localhost/api/work-orders/wo-1/schedule", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{not-json",
        }),
        context,
      ),
      400,
    );

    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_JSON" } });
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.rescheduleWorkOrder).not.toHaveBeenCalled();
  });
});
