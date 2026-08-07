import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  workOrderFindFirst: vi.fn(),
  workOrderUpdate: vi.fn(),
  membershipFindFirst: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst, update: mocks.workOrderUpdate },
    organizationMembership: { findFirst: mocks.membershipFindFirst },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { PATCH } from "@/app/api/work-orders/[workOrderId]/route";

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN" = "MAINTENANCE_MANAGER") {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
    tenant: {
      scope: { organizationId: "org-a", role, allSites: true, siteIds: [], active: true },
    },
  };
}

function workOrder(status: "IN_PROGRESS" | "COMPLETED" | "CANCELLED") {
  return {
    id: "wo-1",
    number: "WO-000001",
    siteId: "site-a",
    assetId: null,
    requesterId: "requester-1",
    assigneeId: "tech-1",
    title: "Inspect utility area",
    description: null,
    type: "CORRECTIVE",
    status,
    priority: "NORMAL",
    requestedAt: new Date("2026-08-07T08:00:00.000Z"),
    plannedStart: new Date("2026-08-07T09:00:00.000Z"),
    dueAt: null,
    startedAt: new Date("2026-08-07T10:00:00.000Z"),
    completedAt: status === "COMPLETED" ? new Date("2026-08-07T11:00:00.000Z") : null,
    downtimeMinutes: 10,
    laborMinutes: 30,
    completionNote: status === "COMPLETED" ? "Original completion note" : null,
    createdAt: new Date("2026-08-07T08:00:00.000Z"),
    updatedAt: new Date("2026-08-07T11:00:00.000Z"),
    checkItems: [{ id: "item-1", completed: true }],
  };
}

function request(status: string, statusNote?: string) {
  return new Request("http://localhost/api/work-orders/wo-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      status,
      ...(statusNote ? { statusNote } : {}),
    }),
  });
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("work order cancel and reopen flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.workOrderUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...workOrder("IN_PROGRESS"),
      ...data,
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("requires a reason before cancellation", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder("IN_PROGRESS"));

    const response = await PATCH(request("CANCELLED"), params);

    await expectStatus(response, 409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("cancels with a dedicated audit action", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder("IN_PROGRESS"));

    const response = await PATCH(request("CANCELLED", "Work no longer required"), params);

    await expectStatus(response, 200);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CANCELLED", actorId: "manager-1" }),
    });
  });

  it("requires a reason before reopening a completed work order", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder("COMPLETED"));

    const response = await PATCH(request("IN_PROGRESS"), params);

    await expectStatus(response, 409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("reopens a completed work order, resets closure and requires a new completion note", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder("COMPLETED"));

    const response = await PATCH(request("IN_PROGRESS", "Issue recurred after verification"), params);

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: expect.objectContaining({
        status: "IN_PROGRESS",
        startedAt: expect.any(Date),
        completedAt: null,
        completionNote: null,
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "REOPENED", actorId: "manager-1" }),
    });
  });

  it("reopens a cancelled work order back to requested", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder("CANCELLED"));

    const response = await PATCH(request("REQUESTED", "Request restored"), params);

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: expect.objectContaining({ status: "REQUESTED", startedAt: null, completedAt: null }),
    });
  });
});
