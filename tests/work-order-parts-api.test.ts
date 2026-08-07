import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  workOrderFindFirst: vi.fn(),
  consumptionFindMany: vi.fn(),
  consumeWorkOrderPart: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst },
    workOrderPartConsumption: { findMany: mocks.consumptionFindMany },
  },
}));

vi.mock("@/lib/work-orders/parts", () => ({
  consumeWorkOrderPart: mocks.consumeWorkOrderPart,
  WorkOrderPartError: class WorkOrderPartError extends Error {},
}));

import { POST } from "@/app/api/work-orders/[workOrderId]/parts/route";

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
    tenant: {
      scope: { organizationId: "org-a", role, allSites: true, siteIds: [], active: true },
    },
  };
}

function workOrder(assigneeId: string | null = "tech-1") {
  return { id: "wo-1", siteId: "site-a", status: "IN_PROGRESS", assigneeId };
}

function request(options?: { key?: string; quantity?: number }) {
  const headers = new Headers({ "content-type": "application/json" });
  if (options?.key !== "") headers.set("Idempotency-Key", options?.key ?? "consume-0001");
  return new Request("http://localhost/api/work-orders/wo-1/parts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      partId: "part-1",
      quantity: options?.quantity ?? 2,
    }),
  });
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("work order parts API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    mocks.workOrderFindFirst.mockResolvedValue(workOrder());
    mocks.consumeWorkOrderPart.mockResolvedValue({
      idempotent: false,
      consumption: { id: "consumption-1", partId: "part-1", quantity: 2 },
    });
  });

  it("requires an idempotency key before attempting a stock write", async () => {
    const response = await POST(request({ key: "" }), params);

    await expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.consumeWorkOrderPart).not.toHaveBeenCalled();
  });

  it("consumes stock for the assigned technician with the supplied idempotency key", async () => {
    const response = await POST(request({ key: "consume-0001" }), params);

    await expectStatus(response, 201);
    expect(mocks.consumeWorkOrderPart).toHaveBeenCalledWith({
      organizationId: "org-a",
      workOrderId: "wo-1",
      partId: "part-1",
      quantity: 2,
      idempotencyKey: "consume-0001",
      actorId: "tech-1",
    });
  });

  it("returns 200 without a second write for an idempotent retry", async () => {
    mocks.consumeWorkOrderPart.mockResolvedValue({
      idempotent: true,
      consumption: { id: "consumption-1", partId: "part-1", quantity: 2 },
    });

    const response = await POST(request({ key: "consume-0001" }), params);

    await expectStatus(response, 200);
  });

  it("blocks a technician from consuming parts on another technician's work order", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder("tech-2"));

    const response = await POST(request(), params);

    await expectStatus(response, 403);
    expect(mocks.consumeWorkOrderPart).not.toHaveBeenCalled();
  });
});
