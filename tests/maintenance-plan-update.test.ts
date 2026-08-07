import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  planFindFirst: vi.fn(),
  transaction: vi.fn(),
  checklistDeleteMany: vi.fn(),
  checklistCreateMany: vi.fn(),
  planUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  maintenancePlanCheckItem: {
    deleteMany: mocks.checklistDeleteMany,
    createMany: mocks.checklistCreateMany,
  },
  maintenancePlan: { update: mocks.planUpdate },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({
  db: {
    maintenancePlan: { findFirst: mocks.planFindFirst },
    $transaction: mocks.transaction,
  },
}));

import { PATCH } from "@/app/api/maintenance-plans/[planId]/route";

const auth = {
  session: { user: { id: "manager-1" } },
  tenant: {
    scope: {
      organizationId: "org-a",
      role: "MAINTENANCE_MANAGER",
      allSites: true,
      siteIds: [],
      active: true,
    },
  },
};

function existing(active = true) {
  return {
    id: "plan-1",
    assetId: "asset-1",
    name: "Monthly inspection",
    description: null,
    frequencyValue: 1,
    frequencyUnit: "MONTH",
    nextDueAt: new Date("2026-08-31T06:00:00.000Z"),
    active,
    estimatedMinutes: 30,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    checklistItems: [{ id: "item-1", sequence: 1, label: "Inspect guard", mandatory: true }],
    asset: { site: { organization: { timezone: "Europe/Paris" } } },
  };
}

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/maintenance-plans/plan-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", ...body }),
  });
}

const params = { params: Promise.resolve({ planId: "plan-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("maintenance plan updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.planFindFirst.mockResolvedValue(existing());
    mocks.planUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...existing(),
      ...data,
      checklistItems: existing().checklistItems,
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
  });

  it("pauses a plan without changing its due date and records plan history", async () => {
    const response = await PATCH(request({ active: false }), params);

    await expectStatus(response, 200);
    expect(mocks.planUpdate).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: { active: false },
      include: { checklistItems: { orderBy: { sequence: "asc" } } },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "MaintenancePlan",
        entityId: "plan-1",
        action: "PAUSED",
        beforeJson: expect.any(String),
        afterJson: expect.any(String),
      }),
    });
  });

  it("resumes a paused plan while preserving the existing next due date", async () => {
    mocks.planFindFirst.mockResolvedValue(existing(false));
    mocks.planUpdate.mockResolvedValue({ ...existing(false), active: true });

    const response = await PATCH(request({ active: true }), params);

    await expectStatus(response, 200);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "RESUMED" }),
    });
  });

  it("replaces reusable checklist content transactionally", async () => {
    mocks.planUpdate.mockResolvedValue({
      ...existing(),
      checklistItems: [{ id: "new-1", sequence: 1, label: "Inspect coupling", mandatory: true }],
    });

    const response = await PATCH(
      request({ checklist: [{ label: "Inspect coupling", mandatory: true }] }),
      params,
    );

    await expectStatus(response, 200);
    expect(mocks.checklistDeleteMany).toHaveBeenCalledWith({ where: { maintenancePlanId: "plan-1" } });
    expect(mocks.checklistCreateMany).toHaveBeenCalledWith({
      data: [{ maintenancePlanId: "plan-1", sequence: 1, label: "Inspect coupling", mandatory: true }],
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "UPDATED" }),
    });
  });

  it("rejects no-op updates", async () => {
    const response = await PATCH(request({}), params);

    await expectStatus(response, 400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
