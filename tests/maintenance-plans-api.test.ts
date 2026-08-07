import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  meterFindFirst: vi.fn(),
  planFindFirst: vi.fn(),
  planFindMany: vi.fn(),
  planCreate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    asset: { findFirst: mocks.assetFindFirst },
    meter: { findFirst: mocks.meterFindFirst },
    maintenancePlan: {
      findFirst: mocks.planFindFirst,
      findMany: mocks.planFindMany,
      create: mocks.planCreate,
    },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { POST } from "@/app/api/maintenance-plans/route";

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

function request(body?: Record<string, unknown>) {
  return new Request("http://localhost/api/maintenance-plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      assetId: "asset-1",
      name: "Monthly inspection",
      frequencyValue: 1,
      frequencyUnit: "MONTH",
      firstDueAt: "2026-08-31T06:00:00.000Z",
      estimatedMinutes: 30,
      checklist: [
        { label: "Inspect guard", mandatory: true },
        { label: "Record condition", mandatory: false },
      ],
      ...body,
    }),
  });
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("maintenance plans API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a", organization: { timezone: "Europe/Paris" } });
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-1" });
    mocks.meterFindFirst.mockResolvedValue({ id: "meter-1" });
    mocks.planFindFirst.mockResolvedValue(null);
    mocks.planCreate.mockResolvedValue({
      id: "plan-1",
      assetId: "asset-1",
      meterId: null,
      name: "Monthly inspection",
      description: null,
      frequencyValue: 1,
      frequencyUnit: "MONTH",
      nextDueAt: new Date("2026-08-31T06:00:00.000Z"),
      nextDueMeterValue: null,
      active: true,
      estimatedMinutes: 30,
      meter: null,
      checklistItems: [
        { id: "item-1", sequence: 1, label: "Inspect guard", mandatory: true },
        { id: "item-2", sequence: 2, label: "Record condition", mandatory: false },
      ],
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("creates a calendar preventive template with reusable checklist content", async () => {
    const response = await POST(request());

    await expectStatus(response, 201);
    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: { id: "asset-1", siteId: "site-a", archivedAt: null },
      select: { id: true },
    });
    expect(mocks.planCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assetId: "asset-1",
        meterId: null,
        frequencyValue: 1,
        frequencyUnit: "MONTH",
        nextDueMeterValue: null,
        active: true,
        checklistItems: {
          create: [
            { sequence: 1, label: "Inspect guard", mandatory: true },
            { sequence: 2, label: "Record condition", mandatory: false },
          ],
        },
      }),
      include: {
        meter: { select: { id: true, code: true, name: true, unit: true } },
        checklistItems: { orderBy: { sequence: "asc" } },
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityType: "MaintenancePlan", action: "CREATED" }),
    });

    if (!response) throw new Error("Expected maintenance plan response");
    const payload = (await response.json()) as { data: { followingDueAt: string } };
    expect(payload.data.followingDueAt).toBe("2026-09-30T06:00:00.000Z");
  });

  it("creates a meter-based plan only for a monotonic meter on the selected asset", async () => {
    mocks.planCreate.mockResolvedValue({
      id: "plan-meter-1",
      assetId: "asset-1",
      meterId: "meter-1",
      name: "Hours-based inspection",
      description: null,
      frequencyValue: 250,
      frequencyUnit: "METER",
      nextDueAt: null,
      nextDueMeterValue: 1000,
      active: true,
      estimatedMinutes: 30,
      meter: { id: "meter-1", code: "HOURS", name: "Operating hours", unit: "h" },
      checklistItems: [],
    });

    const response = await POST(
      request({
        name: "Hours-based inspection",
        frequencyValue: 250,
        frequencyUnit: "METER",
        firstDueAt: undefined,
        meterId: "meter-1",
        firstDueMeterValue: 1000,
        checklist: [],
      }),
    );

    await expectStatus(response, 201);
    expect(mocks.meterFindFirst).toHaveBeenCalledWith({
      where: { id: "meter-1", assetId: "asset-1", allowRollover: false },
      select: { id: true },
    });
    expect(mocks.planCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assetId: "asset-1",
        meterId: "meter-1",
        frequencyValue: 250,
        frequencyUnit: "METER",
        nextDueAt: null,
        nextDueMeterValue: 1000,
      }),
      include: {
        meter: { select: { id: true, code: true, name: true, unit: true } },
        checklistItems: { orderBy: { sequence: "asc" } },
      },
    });

    if (!response) throw new Error("Expected meter maintenance plan response");
    const payload = (await response.json()) as {
      data: { followingDueAt: null; followingDueMeterValue: number };
    };
    expect(payload.data.followingDueAt).toBeNull();
    expect(payload.data.followingDueMeterValue).toBe(1250);
  });

  it("clones checklist content from another plan in the same organization", async () => {
    mocks.planFindFirst.mockResolvedValue({
      id: "source-plan",
      checklistItems: [
        { sequence: 1, label: "Verify lubrication", mandatory: true },
        { sequence: 2, label: "Inspect fasteners", mandatory: true },
      ],
    });

    const response = await POST(
      request({ checklist: undefined, cloneChecklistFromPlanId: "source-plan" }),
    );

    await expectStatus(response, 201);
    expect(mocks.planFindFirst).toHaveBeenCalledWith({
      where: {
        id: "source-plan",
        asset: { site: { organizationId: "org-a" } },
      },
      include: { checklistItems: { orderBy: { sequence: "asc" } } },
    });
    expect(mocks.planCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          checklistItems: {
            create: [
              { sequence: 1, label: "Verify lubrication", mandatory: true },
              { sequence: 2, label: "Inspect fasteners", mandatory: true },
            ],
          },
        }),
      }),
    );
  });

  it("rejects an asset outside the requested site", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    const response = await POST(request());

    await expectStatus(response, 404);
    expect(mocks.planCreate).not.toHaveBeenCalled();
  });

  it("rejects a meter that is not monotonic or does not belong to the selected asset", async () => {
    mocks.meterFindFirst.mockResolvedValue(null);

    const response = await POST(
      request({
        frequencyValue: 250,
        frequencyUnit: "METER",
        firstDueAt: undefined,
        meterId: "meter-foreign",
        firstDueMeterValue: 1000,
      }),
    );

    await expectStatus(response, 404);
    expect(mocks.planCreate).not.toHaveBeenCalled();
  });

  it("requires meter-specific threshold fields for METER recurrence", async () => {
    const response = await POST(
      request({ frequencyUnit: "METER", firstDueAt: undefined }),
    );

    await expectStatus(response, 400);
    expect(mocks.planCreate).not.toHaveBeenCalled();
  });
});
