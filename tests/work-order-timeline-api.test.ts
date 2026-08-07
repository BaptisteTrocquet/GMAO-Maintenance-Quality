import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  workOrderFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst },
    auditLog: { findMany: mocks.auditFindMany },
  },
}));

import { GET } from "@/app/api/work-orders/[workOrderId]/timeline/route";

const auth = {
  session: { user: { id: "user-1" } },
  tenant: {
    scope: {
      organizationId: "org-a",
      role: "VIEWER",
      allSites: true,
      siteIds: [],
      active: true,
    },
  },
};

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("work order timeline API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.workOrderFindFirst.mockResolvedValue({ id: "wo-1" });
    mocks.auditFindMany.mockResolvedValue([
      {
        id: "audit-2",
        action: "PART_CONSUMED",
        createdAt: new Date("2026-08-07T12:00:00.000Z"),
        actor: { id: "tech-1", displayName: "Demo Technician" },
        beforeJson: null,
        afterJson: JSON.stringify({ sku: "SP-001", quantity: 2 }),
      },
      {
        id: "audit-1",
        action: "CREATED",
        createdAt: new Date("2026-08-07T08:00:00.000Z"),
        actor: { id: "manager-1", displayName: "Demo Manager" },
        beforeJson: null,
        afterJson: JSON.stringify({ status: "REQUESTED" }),
      },
    ]);
  });

  it("returns parsed audit events in reverse chronological order for the scoped work order", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/work-orders/wo-1/timeline?organizationId=org-a&siteId=site-a",
      ),
      params,
    );

    await expectStatus(response, 200);
    expect(mocks.workOrderFindFirst).toHaveBeenCalledWith({
      where: {
        id: "wo-1",
        siteId: "site-a",
        site: { organizationId: "org-a", active: true },
      },
      select: { id: true },
    });
    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: { entityType: "WorkOrder", entityId: "wo-1" },
      include: { actor: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: "desc" },
    });

    if (!response) throw new Error("Expected timeline response");
    const payload = (await response.json()) as {
      data: Array<{ action: string; after: { sku?: string; quantity?: number } }>;
    };
    expect(payload.data[0]?.action).toBe("PART_CONSUMED");
    expect(payload.data[0]?.after).toEqual({ sku: "SP-001", quantity: 2 });
  });

  it("does not expose timeline data when the work order is outside tenant/site scope", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(null);

    const response = await GET(
      new Request(
        "http://localhost/api/work-orders/wo-1/timeline?organizationId=org-a&siteId=site-a",
      ),
      params,
    );

    await expectStatus(response, 404);
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
  });
});
