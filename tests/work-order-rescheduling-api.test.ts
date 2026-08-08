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

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "MAINTENANCE_MANAGER" ? "manager-1" : "tech-1" } },
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

function existing() {
  return {
    id: "wo-1",
    number: "WO-000001",
    siteId: "site-a",
    assetId: null,
    requesterId: "requester-1",
    assigneeId: null,
    teamId: null,
    title: "Synthetic planned inspection",
    description: null,
    type: "INSPECTION",
    status: "PLANNED",
    priority: "NORMAL",
    requestedAt: new Date("2026-08-01T08:00:00.000Z"),
    plannedStart: new Date("2026-08-18T06:00:00.000Z"),
    dueAt: new Date("2026-08-18T10:00:00.000Z"),
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

function request() {
  return new Request("http://localhost/api/work-orders/wo-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      plannedStart: "2026-08-19T06:00:00.000Z",
      dueAt: "2026-08-19T10:00:00.000Z",
    }),
  });
}

const context = { params: Promise.resolve({ workOrderId: "wo-1" }) };

function expectResponse(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
  return response;
}

describe("calendar work-order rescheduling API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.workOrderFindFirst.mockResolvedValue(existing());
    mocks.workOrderUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...existing(),
      ...data,
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("requires a tenant/site-scoped work order and audits successful planning changes", async () => {
    const response = expectResponse(await PATCH(request(), context), 200);

    expect(response.status).toBe(200);
    expect(mocks.workOrderFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "wo-1",
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
        },
      }),
    );
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: expect.objectContaining({
        plannedStart: new Date("2026-08-19T06:00:00.000Z"),
        dueAt: new Date("2026-08-19T10:00:00.000Z"),
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "TRIAGED",
        beforeJson: expect.any(String),
        afterJson: expect.any(String),
      }),
    });
  });

  it("blocks technicians from calendar rescheduling", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = expectResponse(await PATCH(request(), context), 403);

    expect(response.status).toBe(403);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("returns an opaque 404 when the work order is outside the selected scope", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(null);

    const response = expectResponse(await PATCH(request(), context), 404);

    expect(response.status).toBe(404);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });
});
