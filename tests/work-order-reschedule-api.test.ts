import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  workOrderFindFirst: vi.fn(),
  workOrderUpdate: vi.fn(),
  auditCreate: vi.fn(),
  membershipFindFirst: vi.fn(),
  teamFindFirst: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: {
      findFirst: mocks.workOrderFindFirst,
      update: mocks.workOrderUpdate,
    },
    organizationMembership: { findFirst: mocks.membershipFindFirst },
    maintenanceTeam: { findFirst: mocks.teamFindFirst },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { PATCH } from "@/app/api/work-orders/[workOrderId]/route";

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
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

const existing = {
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
  status: "PLANNED",
  priority: "NORMAL",
  requestedAt: new Date("2026-08-01T08:00:00.000Z"),
  plannedStart: new Date("2026-08-10T08:00:00.000Z"),
  dueAt: new Date("2026-08-12T16:00:00.000Z"),
  startedAt: null,
  completedAt: null,
  downtimeMinutes: null,
  laborMinutes: null,
  completionNote: null,
  createdAt: new Date("2026-08-01T08:00:00.000Z"),
  updatedAt: new Date("2026-08-01T08:00:00.000Z"),
  checkItems: [],
};

function request(body: unknown) {
  return new Request("http://localhost/api/work-orders/wo-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function requireResponse(response: Response | undefined) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  return response;
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

describe("work-order calendar rescheduling API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.workOrderFindFirst.mockResolvedValue(existing);
    mocks.workOrderUpdate.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ ...existing, ...data }),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("lets a maintenance manager reschedule and records the audited triage event", async () => {
    const response = requireResponse(
      await PATCH(
        request({
          organizationId: "org-a",
          siteId: "site-a",
          plannedStart: "2026-08-11T08:00:00.000Z",
        }),
        params,
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: { plannedStart: new Date("2026-08-11T08:00:00.000Z") },
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

  it("blocks a technician from rescheduling planning dates", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = requireResponse(
      await PATCH(
        request({
          organizationId: "org-a",
          siteId: "site-a",
          dueAt: "2026-08-13T16:00:00.000Z",
        }),
        params,
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a due date moved before the planned start", async () => {
    const response = requireResponse(
      await PATCH(
        request({
          organizationId: "org-a",
          siteId: "site-a",
          dueAt: "2026-08-09T16:00:00.000Z",
        }),
        params,
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });
});
