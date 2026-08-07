import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retryFailed: vi.fn(),
  deliver: vi.fn(),
  deliveryId: vi.fn(),
  listSubscriptions: vi.fn(),
  sourceFindMany: vi.fn(),
  deliveryFindFirst: vi.fn(),
  workOrderFindUnique: vi.fn(),
}));

vi.mock("@/lib/webhooks/delivery", () => ({
  retryFailedWebhookDeliveries: mocks.retryFailed,
  deliverWebhook: mocks.deliver,
  webhookDeliveryId: mocks.deliveryId,
}));
vi.mock("@/lib/webhooks/registry", () => ({
  listAllWebhookSubscriptions: mocks.listSubscriptions,
}));
vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      findMany: mocks.sourceFindMany,
      findFirst: mocks.deliveryFindFirst,
    },
    workOrder: { findUnique: mocks.workOrderFindUnique },
  },
}));

import { processWebhookQueue } from "@/lib/webhooks/worker";

const source = {
  id: "audit-work-order-1",
  actorId: null,
  entityType: "WorkOrder",
  entityId: "wo-1",
  action: "PUBLIC_REQUEST_CREATED",
  beforeJson: null,
  afterJson: null,
  createdAt: new Date("2026-08-07T20:00:00.000Z"),
};

const subscription = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Maintenance events",
  url: "https://hooks.example.test/opengmao",
  eventTypes: ["work_order.created"] as const,
  createdById: "manager-1",
  createdAt: new Date("2026-08-07T19:00:00.000Z"),
  revokedAt: null,
};

describe("webhook worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retryFailed.mockResolvedValue([]);
    mocks.listSubscriptions.mockResolvedValue([subscription]);
    mocks.sourceFindMany.mockResolvedValue([source]);
    mocks.workOrderFindUnique.mockResolvedValue({
      id: "wo-1",
      number: "WO-P-DEMO",
      title: "Unexpected vibration",
      status: "REQUESTED",
      requestedAt: new Date("2026-08-07T20:00:00.000Z"),
      siteId: "site-a",
      site: { organizationId: "org-a" },
      asset: { code: "ASSET-100" },
    });
    mocks.deliveryId.mockReturnValue("delivery-1");
    mocks.deliveryFindFirst.mockResolvedValue(null);
    mocks.deliver.mockResolvedValue({ delivered: true, deliveryId: "delivery-1" });
  });

  it("delivers a new work-order event only to matching site subscriptions", async () => {
    const result = await processWebhookQueue({ now: new Date("2026-08-07T20:05:00.000Z") });

    expect(result.processedEvents).toBe(1);
    expect(mocks.deliver).toHaveBeenCalledWith({
      subscription,
      event: {
        id: "audit-work-order-1",
        type: "work_order.created",
        createdAt: "2026-08-07T20:00:00.000Z",
        data: {
          workOrder: {
            id: "wo-1",
            number: "WO-P-DEMO",
            title: "Unexpected vibration",
            status: "REQUESTED",
            requestedAt: "2026-08-07T20:00:00.000Z",
            assetCode: "ASSET-100",
          },
        },
      },
      now: new Date("2026-08-07T20:05:00.000Z"),
    });
  });

  it("does not redeliver an event that already has delivery state", async () => {
    mocks.deliveryFindFirst.mockResolvedValue({
      id: "audit-delivery",
      entityType: "WebhookDelivery",
      entityId: "delivery-1",
      action: "DELIVERED",
      createdAt: new Date(),
    });

    await processWebhookQueue({ now: new Date("2026-08-07T20:05:00.000Z") });

    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("does not cross organization or site boundaries", async () => {
    mocks.listSubscriptions.mockResolvedValue([
      { ...subscription, siteId: "site-b" },
      { ...subscription, id: "sub-org-b", organizationId: "org-b" },
    ]);

    await processWebhookQueue({ now: new Date("2026-08-07T20:05:00.000Z") });

    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
