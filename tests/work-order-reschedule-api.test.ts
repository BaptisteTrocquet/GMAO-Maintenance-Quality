import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class WorkOrderRescheduleError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  class ZonedDateTimeError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    siteFindFirst: vi.fn(),
    rescheduleWorkOrder: vi.fn(),
    siteLocalDateTimeToUtc: vi.fn(),
    WorkOrderRescheduleError,
    ZonedDateTimeError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/maintenance/reschedule", () => ({
  rescheduleWorkOrder: mocks.rescheduleWorkOrder,
  WorkOrderRescheduleError: mocks.WorkOrderRescheduleError,
}));
vi.mock("@/lib/maintenance/zoned-date-time", () => ({
  siteLocalDateTimeToUtc: mocks.siteLocalDateTimeToUtc,
  ZonedDateTimeError: mocks.ZonedDateTimeError,
}));

import { PATCH } from "@/app/api/work-orders/[workOrderId]/schedule/route";

function auth(role: "VIEWER" | "MAINTENANCE_MANAGER") {
  return {
    session: { user: { id: role === "VIEWER" ? "viewer-1" : "planner-1" } },
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

function requireResponse(response: Response | undefined) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  return response;
}

const context = { params: Promise.resolve({ workOrderId: "wo-1" }) };
const payload = {
  organizationId: "org-a",
  siteId: "site-a",
  localDate: "2026-08-12",
  localTime: "08:00",
  reason: "Planning adjustment",
};

function request(body: unknown = payload) {
  return new Request("http://localhost/api/work-orders/wo-1/schedule", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("work-order reschedule API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.siteFindFirst.mockResolvedValue({
      organization: { timezone: "Europe/Paris" },
    });
    mocks.siteLocalDateTimeToUtc.mockReturnValue(new Date("2026-08-12T06:00:00.000Z"));
    mocks.rescheduleWorkOrder.mockResolvedValue({
      id: "wo-1",
      number: "WO-0001",
      status: "PLANNED",
      plannedStart: new Date("2026-08-12T06:00:00.000Z"),
    });
  });

  it("requires work:update permission before resolving site scheduling data", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = requireResponse(await PATCH(request(), context));
    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.rescheduleWorkOrder).not.toHaveBeenCalled();
  });

  it("resolves the organization timezone server-side and schedules within site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = requireResponse(await PATCH(request(), context));
    expect(response.status).toBe(200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: {
        id: "site-a",
        organizationId: "org-a",
        active: true,
        organization: { active: true },
      },
      select: { organization: { select: { timezone: true } } },
    });
    expect(mocks.siteLocalDateTimeToUtc).toHaveBeenCalledWith({
      localDate: "2026-08-12",
      localTime: "08:00",
      timeZone: "Europe/Paris",
    });
    expect(mocks.rescheduleWorkOrder).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderId: "wo-1",
      plannedStart: new Date("2026-08-12T06:00:00.000Z"),
      actorId: "planner-1",
      reason: "Planning adjustment",
    });
  });

  it("returns 404 when the selected site is outside the organization scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = requireResponse(await PATCH(request(), context));
    expect(response.status).toBe(404);
    expect(mocks.rescheduleWorkOrder).not.toHaveBeenCalled();
  });

  it("maps workflow scheduling conflicts to 409", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.rescheduleWorkOrder.mockRejectedValue(
      new mocks.WorkOrderRescheduleError(
        "SCHEDULING_REQUIRES_APPROVAL",
        "Approve the work order before assigning a planned start",
      ),
    );

    const response = requireResponse(await PATCH(request(), context));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "SCHEDULING_REQUIRES_APPROVAL" },
    });
  });

  it("maps nonexistent local DST times to a validation error", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.siteLocalDateTimeToUtc.mockImplementation(() => {
      throw new mocks.ZonedDateTimeError(
        "NONEXISTENT_LOCAL_TIME",
        "The requested local time does not exist",
      );
    });

    const response = requireResponse(await PATCH(request(), context));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "NONEXISTENT_LOCAL_TIME" },
    });
  });

  it("rejects malformed JSON before authentication", async () => {
    const response = requireResponse(
      await PATCH(
        new Request("http://localhost/api/work-orders/wo-1/schedule", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{broken-json",
        }),
        context,
      ),
    );
    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
