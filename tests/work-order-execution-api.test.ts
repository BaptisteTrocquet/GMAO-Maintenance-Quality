import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  workOrderFindFirst: vi.fn(),
  workOrderUpdate: vi.fn(),
  checkItemCreateMany: vi.fn(),
  checkItemUpdate: vi.fn(),
  transaction: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst, update: mocks.workOrderUpdate },
    workOrderCheckItem: {
      createMany: mocks.checkItemCreateMany,
      update: mocks.checkItemUpdate,
    },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

import { PATCH } from "@/app/api/work-orders/[workOrderId]/execution/route";

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
    tenant: {
      scope: { organizationId: "org-a", role, allSites: true, siteIds: [], active: true },
    },
  };
}

function workOrder(input?: { status?: "IN_PROGRESS" | "BLOCKED" | "PLANNED"; assigneeId?: string | null }) {
  return {
    id: "wo-1",
    number: "WO-000001",
    siteId: "site-a",
    assetId: null,
    requesterId: "requester-1",
    assigneeId: input?.assigneeId ?? "tech-1",
    title: "Inspect utility area",
    description: null,
    type: "CORRECTIVE",
    status: input?.status ?? "IN_PROGRESS",
    priority: "NORMAL",
    requestedAt: new Date("2026-08-07T08:00:00.000Z"),
    plannedStart: new Date("2026-08-07T10:00:00.000Z"),
    dueAt: null,
    startedAt: new Date("2026-08-07T10:00:00.000Z"),
    completedAt: null,
    downtimeMinutes: null,
    laborMinutes: null,
    completionNote: null,
    createdAt: new Date("2026-08-07T08:00:00.000Z"),
    updatedAt: new Date("2026-08-07T10:00:00.000Z"),
    checkItems: [{ id: "item-1", workOrderId: "wo-1", label: "Inspect guard", completed: false, note: null }],
  };
}

function request(body: unknown) {
  return new Request("http://localhost/api/work-orders/wo-1/execution", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("work order execution API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    mocks.workOrderFindFirst
      .mockResolvedValueOnce(workOrder())
      .mockResolvedValueOnce({ ...workOrder(), laborMinutes: 45, downtimeMinutes: 15 });
    mocks.workOrderUpdate.mockResolvedValue({ id: "wo-1", laborMinutes: 45, downtimeMinutes: 15 });
    mocks.checkItemUpdate.mockResolvedValue({ id: "item-1", completed: true });
    mocks.checkItemCreateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (operations: Promise<unknown>[]) => Promise.all(operations));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("records labor, downtime, completion note and checklist progress for the assigned technician", async () => {
    const response = await PATCH(
      request({
        organizationId: "org-a",
        siteId: "site-a",
        laborMinutes: 45,
        downtimeMinutes: 15,
        completionNote: "Guard inspected and adjusted.",
        checklistUpdates: [{ id: "item-1", completed: true, note: "OK" }],
      }),
      params,
    );

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: expect.objectContaining({ laborMinutes: 45, downtimeMinutes: 15 }),
    });
    expect(mocks.checkItemUpdate).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: expect.objectContaining({ completed: true, note: "OK" }),
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "EXECUTION_UPDATED", actorId: "tech-1" }),
    });
  });

  it("blocks execution capture by a technician who is not assigned", async () => {
    mocks.workOrderFindFirst.mockReset();
    mocks.workOrderFindFirst.mockResolvedValue(workOrder({ assigneeId: "tech-2" }));

    const response = await PATCH(
      request({ organizationId: "org-a", siteId: "site-a", laborMinutes: 15 }),
      params,
    );

    await expectStatus(response, 403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("allows a maintenance manager to configure checklist items", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await PATCH(
      request({
        organizationId: "org-a",
        siteId: "site-a",
        checklistAdd: ["Isolate energy", "Inspect coupling"],
      }),
      params,
    );

    await expectStatus(response, 200);
    expect(mocks.checkItemCreateMany).toHaveBeenCalledWith({
      data: [
        { workOrderId: "wo-1", label: "Isolate energy" },
        { workOrderId: "wo-1", label: "Inspect coupling" },
      ],
    });
  });

  it("rejects checklist items that do not belong to the work order", async () => {
    const response = await PATCH(
      request({
        organizationId: "org-a",
        siteId: "site-a",
        checklistUpdates: [{ id: "foreign-item", completed: true }],
      }),
      params,
    );

    await expectStatus(response, 404);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects execution capture before the work order starts", async () => {
    mocks.workOrderFindFirst.mockReset();
    mocks.workOrderFindFirst.mockResolvedValue(workOrder({ status: "PLANNED" }));

    const response = await PATCH(
      request({ organizationId: "org-a", siteId: "site-a", laborMinutes: 10 }),
      params,
    );

    await expectStatus(response, 409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
