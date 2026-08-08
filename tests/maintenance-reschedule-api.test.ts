import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  workOrderFindFirst: vi.fn(),
  workOrderUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst, update: mocks.workOrderUpdate },
    organizationMembership: { findFirst: vi.fn() },
    maintenanceTeam: { findFirst: vi.fn() },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { PATCH } from "@/app/api/work-orders/[workOrderId]/route";

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "MAINTENANCE_MANAGER" ? "manager-1" : "tech-1" } },
    tenant: {
      scope: { organizationId: "org-a", role, allSites: true, siteIds: [], active: true },
    },
  };
}

function existing() {
  return {
    id: "wo-1",
    number: "WO-000001",
    siteId: "site-a",
    assetId: null,
    requesterId: "requester-1",
    assigneeId: null,
    teamId: null,
    title: "Synthetic inspection",
    description: null,
    type: "PREVENTIVE",
    status: "PLANNED" as const,
    priority: "NORMAL" as const,
    requestedAt: new Date("2026-08-01T08:00:00.000Z"),
    plannedStart: new Date("2026-08-08T08:00:00.000Z"),
    dueAt: new Date("2026-08-08T12:00:00.000Z"),
    startedAt: null,
    completedAt: null,
    downtimeMinutes: null,
    laborMinutes: null,
    completionNote: null,
    createdAt: new Date("2026-08-01T08:00:00.000Z"),
    updatedAt: new Date("2026-08-01T08:00:00.000Z"),
    checkItems: [],
  };
}

function request(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  mocks.authenticateRequest.mockResolvedValue(auth(role));
  return new Request("http://localhost/api/work-orders/wo-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      plannedStart: "2026-08-12T08:00:00.000Z",
    }),
  });
}

describe("calendar rescheduling API contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workOrderFindFirst.mockResolvedValue(existing());
    mocks.workOrderUpdate.mockResolvedValue({
      ...existing(),
      plannedStart: new Date("2026-08-12T08:00:00.000Z"),
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("requires work:manage and blocks technician drag/drop mutations", async () => {
    const response = await PATCH(request("TECHNICIAN"), params);
    expect(response?.status).toBe(403);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("audits an authorized calendar reschedule through the normal work-order path", async () => {
    const response = await PATCH(request("MAINTENANCE_MANAGER"), params);
    expect(response?.status).toBe(200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: { plannedStart: new Date("2026-08-12T08:00:00.000Z") },
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
});
