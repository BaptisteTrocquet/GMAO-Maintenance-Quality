import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  workOrderFindMany: vi.fn(),
  workOrderCreate: vi.fn(),
  workOrderCount: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  recordIntegrationEvent: vi.fn(),
}));

const tx = {
  workOrder: { create: mocks.workOrderCreate },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/integrations/event-log", () => ({
  recordIntegrationEventInTransaction: mocks.recordIntegrationEvent,
}));

vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    asset: { findFirst: mocks.assetFindFirst },
    workOrder: {
      findMany: mocks.workOrderFindMany,
      count: mocks.workOrderCount,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST } from "@/app/api/work-orders/route";

const auth = {
  session: { user: { id: "user-1" } },
  tenant: {
    scope: {
      organizationId: "org-a",
      role: "ADMIN",
      allSites: true,
      siteIds: [],
      active: true,
    },
  },
};

function postRequest(body: unknown) {
  return new Request("http://localhost/api/work-orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("site-scoped work orders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.recordIntegrationEvent.mockResolvedValue({ event: { id: "event-1" }, replayed: false });
  });

  it("lists work orders directly by site, including requests without an asset", async () => {
    mocks.workOrderFindMany.mockResolvedValue([
      { id: "wo-1", siteId: "site-a", assetId: null, title: "Inspect utility area" },
    ]);

    const response = await GET(
      new Request("http://localhost/api/work-orders?organizationId=org-a&siteId=site-a"),
    );

    expect(response).toBeDefined();
    expect(response?.status).toBe(200);
    expect(mocks.workOrderFindMany).toHaveBeenCalledWith({
      where: { siteId: "site-a" },
      include: { site: true, asset: true, assignee: true },
      orderBy: { requestedAt: "desc" },
    });
  });

  it("creates work order, business audit and outbound event in one transaction", async () => {
    const requestedAt = new Date("2026-08-08T09:30:00.000Z");
    mocks.workOrderCount.mockResolvedValue(0);
    mocks.workOrderCreate.mockResolvedValue({
      id: "wo-1",
      number: "WO-000001",
      siteId: "site-a",
      assetId: null,
      requesterId: "user-1",
      title: "Inspect utility area",
      type: "CORRECTIVE",
      priority: "NORMAL",
      status: "REQUESTED",
      requestedAt,
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });

    const response = await POST(
      postRequest({
        organizationId: "org-a",
        siteId: "site-a",
        title: "Inspect utility area",
        type: "CORRECTIVE",
      }),
    );

    expect(response).toBeDefined();
    expect(response?.status).toBe(201);
    expect(mocks.workOrderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        siteId: "site-a",
        requesterId: "user-1",
        number: "WO-000001",
        title: "Inspect utility area",
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-1",
        entityType: "WorkOrder",
        entityId: "wo-1",
        action: "CREATED",
      }),
    });
    expect(mocks.recordIntegrationEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        direction: "OUTBOUND",
        channel: "webhook",
        eventType: "work_order.created",
        sourceId: "audit-1",
        correlationId: "wo-1",
        subjectId: "wo-1",
        occurredAt: requestedAt,
        payload: {
          workOrder: expect.objectContaining({ id: "wo-1", assetCode: null }),
        },
      }),
    );
  });

  it("rejects an asset that does not belong to the requested site", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    const response = await POST(
      postRequest({
        organizationId: "org-a",
        siteId: "site-a",
        assetId: "asset-b",
        title: "Foreign asset request",
        type: "CORRECTIVE",
      }),
    );

    expect(response).toBeDefined();
    expect(response?.status).toBe(404);
    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: { id: "asset-b", siteId: "site-a", archivedAt: null },
      select: { id: true, code: true },
    });
    expect(mocks.workOrderCreate).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
