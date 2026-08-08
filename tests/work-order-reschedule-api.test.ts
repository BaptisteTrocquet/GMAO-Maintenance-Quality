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
    auditLog: { create: mocks.auditCreate },
  },
}));

import { POST } from "@/app/api/work-orders/[workOrderId]/reschedule/route";

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
    tenant: {
      scope: { organizationId: "org-a", role, allSites: true, siteIds: [], active: true },
    },
  };
}

function workOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "wo-1",
    number: "WO-000001",
    siteId: "site-a",
    status: "PLANNED",
    plannedStart: new Date("2026-08-08T12:30:00.000Z"),
    dueAt: new Date("2026-08-15T16:00:00.000Z"),
    site: { organization: { timezone: "Europe/Paris" } },
    ...overrides,
  };
}

function request(dateKey: string) {
  return new Request("http://localhost/api/work-orders/wo-1/reschedule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", dateKey }),
  });
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("work order reschedule API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.workOrderFindFirst.mockResolvedValue(workOrder());
    mocks.workOrderUpdate.mockImplementation(
      async ({ data }: { data: { plannedStart: Date } }) => ({
        ...workOrder(),
        plannedStart: data.plannedStart,
      }),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("preserves the site-local start time and audits a manager reschedule", async () => {
    const response = await POST(request("2026-08-10"), params);

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: { plannedStart: new Date("2026-08-10T12:30:00.000Z") },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "RESCHEDULED",
        afterJson: expect.stringContaining('"localTime":"14:30"'),
      }),
    });
  });

  it("plans previously unscheduled work at 09:00 site-local time", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder({ plannedStart: null }));

    const response = await POST(request("2026-08-10"), params);

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: { plannedStart: new Date("2026-08-10T07:00:00.000Z") },
    });
  });

  it("blocks technicians because calendar rescheduling requires work:manage", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await POST(request("2026-08-10"), params);

    await expectStatus(response, 403);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects moving planned start after the due date", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(
      workOrder({ dueAt: new Date("2026-08-09T08:00:00.000Z") }),
    );

    const response = await POST(request("2026-08-10"), params);

    await expectStatus(response, 409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects completed work orders", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder({ status: "COMPLETED" }));

    const response = await POST(request("2026-08-10"), params);

    await expectStatus(response, 409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("is idempotent when dropped back onto the same local day", async () => {
    const response = await POST(request("2026-08-08"), params);

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
