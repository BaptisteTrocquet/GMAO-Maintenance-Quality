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
    maintenanceTeam: { findFirst: vi.fn() },
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

const existing = {
  id: "wo-1",
  number: "WO-000001",
  siteId: "site-a",
  assetId: null,
  requesterId: "requester-1",
  assigneeId: null,
  teamId: null,
  title: "Inspect generic pump",
  description: null,
  type: "CORRECTIVE" as const,
  status: "APPROVED" as const,
  priority: "NORMAL" as const,
  requestedAt: new Date("2026-08-07T08:00:00.000Z"),
  plannedStart: new Date("2026-08-10T06:00:00.000Z"),
  dueAt: new Date("2026-08-20T16:00:00.000Z"),
  startedAt: null,
  completedAt: null,
  downtimeMinutes: null,
  laborMinutes: null,
  completionNote: null,
  createdAt: new Date("2026-08-07T08:00:00.000Z"),
  updatedAt: new Date("2026-08-07T08:00:00.000Z"),
  checkItems: [],
};

function request(plannedStart: string) {
  return new Request("http://localhost/api/work-orders/wo-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      plannedStart,
    }),
  });
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

describe("calendar rescheduling API contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.workOrderFindFirst.mockResolvedValue(existing);
    mocks.workOrderUpdate.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ ...existing, ...data }),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("lets work managers reschedule and records the existing TRIAGED audit event", async () => {
    const response = await PATCH(request("2026-08-12T06:00:00.000Z"), params);

    expect(response?.status).toBe(200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: { plannedStart: new Date("2026-08-12T06:00:00.000Z") },
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

  it("does not let a technician bypass work:manage through calendar rescheduling", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await PATCH(request("2026-08-12T06:00:00.000Z"), params);

    expect(response?.status).toBe(403);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
