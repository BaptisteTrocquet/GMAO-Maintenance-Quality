import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class StockReservationError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    workOrderFindFirst: vi.fn(),
    listReservations: vi.fn(),
    reserveStock: vi.fn(),
    releaseStock: vi.fn(),
    StockReservationError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { workOrder: { findFirst: mocks.workOrderFindFirst } } }));
vi.mock("@/lib/inventory/reservations", () => ({
  listWorkOrderReservations: mocks.listReservations,
  reserveWorkOrderStock: mocks.reserveStock,
  releaseWorkOrderStock: mocks.releaseStock,
  StockReservationError: mocks.StockReservationError,
}));

import { DELETE, GET, POST } from "@/app/api/work-orders/[workOrderId]/reservations/route";

function auth(role: "TECHNICIAN" | "MAINTENANCE_MANAGER") {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
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

function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
  return response;
}

describe("work-order reservation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workOrderFindFirst.mockResolvedValue({ id: "wo-1", siteId: "site-a" });
    mocks.listReservations.mockResolvedValue([]);
    mocks.reserveStock.mockResolvedValue({ id: "reservation-1", status: "ACTIVE" });
    mocks.releaseStock.mockResolvedValue({ id: "reservation-1", status: "RELEASED" });
  });

  it("lets technicians read reservations in an accessible site", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await GET(
      new Request(
        "http://localhost/api/work-orders/wo-1/reservations?organizationId=org-a&siteId=site-a",
      ),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.listReservations).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderId: "wo-1",
    });
  });

  it("prevents technicians from creating reservations", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await POST(
      new Request("http://localhost/api/work-orders/wo-1/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          binId: "bin-1",
          partId: "part-1",
          quantity: 2,
        }),
      }),
      context,
    );

    expectStatus(response, 403);
    expect(mocks.reserveStock).not.toHaveBeenCalled();
  });

  it("lets maintenance managers reserve stock in their site", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await POST(
      new Request("http://localhost/api/work-orders/wo-1/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          binId: "bin-1",
          partId: "part-1",
          quantity: 2,
        }),
      }),
      context,
    );

    expectStatus(response, 201);
    expect(mocks.reserveStock).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderId: "wo-1",
      binId: "bin-1",
      partId: "part-1",
      quantity: 2,
      actorId: "manager-1",
    });
  });

  it("lets maintenance managers release a reservation", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await DELETE(
      new Request("http://localhost/api/work-orders/wo-1/reservations", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          binId: "bin-1",
          partId: "part-1",
        }),
      }),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.releaseStock).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderId: "wo-1",
      binId: "bin-1",
      partId: "part-1",
      actorId: "manager-1",
    });
  });
});
