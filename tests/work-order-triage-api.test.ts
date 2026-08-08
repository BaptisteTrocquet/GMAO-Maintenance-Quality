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

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
    tenant: {
      scope: { organizationId: "org-a", role, allSites: true, siteIds: [], active: true },
    },
  };
}

function existing(
  status: "REQUESTED" | "APPROVED" | "PLANNED" | "IN_PROGRESS" = "REQUESTED",
  assigneeId: string | null = null,
) {
  return {
    id: "wo-1",
    number: "WO-000001",
    siteId: "site-a",
    assetId: null,
    requesterId: "requester-1",
    assigneeId,
    title: "Inspect utility area",
    description: null,
    type: "CORRECTIVE",
    status,
    priority: "NORMAL",
    requestedAt: new Date("2026-08-07T08:00:00.000Z"),
    plannedStart: status === "PLANNED" ? new Date("2026-08-07T12:00:00.000Z") : null,
    dueAt: null,
    startedAt: null,
    completedAt: null,
    downtimeMinutes: null,
    laborMinutes: null,
    completionNote: null,
    createdAt: new Date("2026-08-07T08:00:00.000Z"),
    updatedAt: new Date("2026-08-07T08:00:00.000Z"),
  };
}

function request(body: unknown) {
  return new Request("http://localhost/api/work-orders/wo-1", {
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

describe("work order triage API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.workOrderFindFirst.mockResolvedValue(existing());
    mocks.workOrderUpdate.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ ...existing(), ...data }),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("lets a maintenance manager approve and audit a requested work order", async () => {
    const response = await PATCH(
      request({
        organizationId: "org-a",
        siteId: "site-a",
        status: "APPROVED",
        statusNote: "Validated",
      }),
      params,
    );

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: expect.objectContaining({ status: "APPROVED" }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "STATUS_CHANGED",
      }),
    });
  });

  it("lets a manager reschedule planning dates and records an audit event", async () => {
    const response = await PATCH(
      request({
        organizationId: "org-a",
        siteId: "site-a",
        plannedStart: "2026-08-08T08:00:00.000Z",
        dueAt: "2026-08-08T12:00:00.000Z",
      }),
      params,
    );

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: expect.objectContaining({
        plannedStart: new Date("2026-08-08T08:00:00.000Z"),
        dueAt: new Date("2026-08-08T12:00:00.000Z"),
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "TRIAGED",
      }),
    });
  });

  it("lets a manager set priority, category and assignee", async () => {
    mocks.membershipFindFirst.mockResolvedValue({ id: "membership-1" });
    const response = await PATCH(
      request({
        organizationId: "org-a",
        siteId: "site-a",
        priority: "HIGH",
        type: "SAFETY",
        assigneeId: "tech-1",
      }),
      params,
    );

    await expectStatus(response, 200);
    expect(mocks.membershipFindFirst).toHaveBeenCalled();
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: expect.objectContaining({
        priority: "HIGH",
        type: "SAFETY",
        assigneeId: "tech-1",
      }),
    });
  });

  it("blocks a technician from calendar rescheduling fields", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    const response = await PATCH(
      request({
        organizationId: "org-a",
        siteId: "site-a",
        plannedStart: "2026-08-09T08:00:00.000Z",
      }),
      params,
    );

    await expectStatus(response, 403);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("blocks a technician from triage and assignment fields", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    const response = await PATCH(
      request({ organizationId: "org-a", siteId: "site-a", priority: "HIGH" }),
      params,
    );

    await expectStatus(response, 403);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("lets the assigned technician start a planned work order", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    mocks.workOrderFindFirst.mockResolvedValue(existing("PLANNED", "tech-1"));
    mocks.workOrderUpdate.mockResolvedValue({
      ...existing("PLANNED", "tech-1"),
      status: "IN_PROGRESS",
    });

    const response = await PATCH(
      request({ organizationId: "org-a", siteId: "site-a", status: "IN_PROGRESS" }),
      params,
    );

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: expect.objectContaining({ status: "IN_PROGRESS", startedAt: expect.any(Date) }),
    });
  });

  it("blocks a technician from executing a work order assigned to someone else", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    mocks.workOrderFindFirst.mockResolvedValue(existing("PLANNED", "tech-2"));

    const response = await PATCH(
      request({ organizationId: "org-a", siteId: "site-a", status: "IN_PROGRESS" }),
      params,
    );

    await expectStatus(response, 403);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("rejects an invalid direct transition from requested to completed", async () => {
    const response = await PATCH(
      request({ organizationId: "org-a", siteId: "site-a", status: "COMPLETED" }),
      params,
    );

    await expectStatus(response, 409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("rejects an assignee who is not active for the work order site", async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);
    const response = await PATCH(
      request({ organizationId: "org-a", siteId: "site-a", assigneeId: "tech-foreign" }),
      params,
    );

    await expectStatus(response, 404);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });
});
