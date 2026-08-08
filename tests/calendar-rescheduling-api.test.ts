import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  workOrderFindFirst: vi.fn(),
  workOrderUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst, update: mocks.workOrderUpdate },
    organizationMembership: { findFirst: vi.fn() },
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
  title: "Inspect utility area",
  description: null,
  type: "CORRECTIVE",
  status: "PLANNED",
  priority: "NORMAL",
  requestedAt: new Date("2026-08-07T08:00:00.000Z"),
  plannedStart: new Date("2026-08-08T06:00:00.000Z"),
  dueAt: new Date("2026-08-08T14:00:00.000Z"),
  startedAt: null,
  completedAt: null,
  downtimeMinutes: null,
  laborMinutes: null,
  completionNote: null,
  createdAt: new Date("2026-08-07T08:00:00.000Z"),
  updatedAt: new Date("2026-08-07T08:00:00.000Z"),
  checkItems: [],
};

function request() {
  return new Request("http://localhost/api/work-orders/wo-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      plannedStart: "2026-08-10T06:00:00.000Z",
      dueAt: "2026-08-10T14:00:00.000Z",
    }),
  });
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("calendar rescheduling API contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.workOrderFindFirst.mockResolvedValue(existing);
    mocks.workOrderUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...existing,
      ...data,
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("uses work:manage and writes the existing TRIAGED audit event", async () => {
    const response = await PATCH(request(), params);

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: expect.objectContaining({
        plannedStart: new Date("2026-08-10T06:00:00.000Z"),
        dueAt: new Date("2026-08-10T14:00:00.000Z"),
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

  it("rejects a technician trying to reschedule through the same API", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await PATCH(request(), params);

    await expectStatus(response, 403);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
