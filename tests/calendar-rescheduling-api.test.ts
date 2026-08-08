import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  transaction: vi.fn(),
  workOrderFindFirst: vi.fn(),
  workOrderUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

const tx = {
  workOrder: {
    findFirst: mocks.workOrderFindFirst,
    update: mocks.workOrderUpdate,
  },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    $transaction: mocks.transaction,
  },
}));

import { PATCH } from "@/app/api/work-orders/[workOrderId]/reschedule/route";

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
};

function request(targetDateKey: string) {
  return new Request("http://localhost/api/work-orders/wo-1/reschedule", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      targetDateKey,
    }),
  });
}

function requireResponse(response: Response | undefined) {
  expect(response).toBeDefined();
  return response as Response;
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

describe("calendar rescheduling API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.siteFindFirst.mockResolvedValue({
      id: "site-a",
      organization: { timezone: "Europe/Paris" },
    });
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.workOrderFindFirst.mockResolvedValue(existing);
    mocks.workOrderUpdate.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ ...existing, ...data }),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("reschedules in the site timezone and records a RESCHEDULED audit event", async () => {
    const response = requireResponse(await PATCH(request("2026-08-12"), params));

    expect(response.status).toBe(200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: { plannedStart: new Date("2026-08-12T06:00:00.000Z") },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "RESCHEDULED",
        afterJson: expect.stringContaining('"targetDateKey":"2026-08-12"'),
      }),
    });
  });

  it("does not let a technician bypass work:manage through drag/drop", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = requireResponse(await PATCH(request("2026-08-12"), params));

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects completed work orders even for managers", async () => {
    mocks.workOrderFindFirst.mockResolvedValue({ ...existing, status: "COMPLETED" });

    const response = requireResponse(await PATCH(request("2026-08-12"), params));

    expect(response.status).toBe(409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a move that would place planned start after the due date", async () => {
    const response = requireResponse(await PATCH(request("2026-08-21"), params));

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_PLANNING");
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("treats a drop on the current planned day as a no-op without audit noise", async () => {
    const response = requireResponse(await PATCH(request("2026-08-10"), params));

    expect(response.status).toBe(200);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("does not reveal a site outside the requested organization", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = requireResponse(await PATCH(request("2026-08-12"), params));

    expect(response.status).toBe(404);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
