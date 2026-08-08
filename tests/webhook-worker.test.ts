import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retryFailed: vi.fn(),
  deliver: vi.fn(),
  deliveryId: vi.fn(),
  listSubscriptions: vi.fn(),
  listPendingEvents: vi.fn(),
  markProcessed: vi.fn(),
  deliveryFindFirst: vi.fn(),
}));

vi.mock("@/lib/webhooks/delivery", () => ({
  retryFailedWebhookDeliveries: mocks.retryFailed,
  deliverWebhook: mocks.deliver,
  webhookDeliveryId: mocks.deliveryId,
}));
vi.mock("@/lib/webhooks/registry", () => ({
  listAllWebhookSubscriptions: mocks.listSubscriptions,
}));
vi.mock("@/lib/integrations/event-log", () => ({
  listPendingIntegrationEvents: mocks.listPendingEvents,
  markIntegrationEventProcessed: mocks.markProcessed,
}));
vi.mock("@/lib/db", () => ({
  db: {
    auditLog: { findFirst: mocks.deliveryFindFirst },
  },
}));

import { processWebhookQueue } from "@/lib/webhooks/worker";

const sourceEvent = {
  version: 1 as const,
  id: "e".repeat(64),
  organizationId: "org-a",
  siteId: "site-a",
  direction: "OUTBOUND" as const,
  channel: "webhook",
  eventType: "work_order.created",
  sourceId: "audit-work-order-1",
  correlationId: "wo-1",
  causationId: null,
  subjectType: "WorkOrder",
  subjectId: "wo-1",
  occurredAt: "2026-08-05T20:00:00.000Z",
  payloadHash: "f".repeat(64),
  payload: {
    workOrder: {
      id: "wo-1",
      number: "WO-P-DEMO",
      title: "Unexpected vibration",
      status: "REQUESTED",
      requestedAt: "2026-08-05T20:00:00.000Z",
      assetCode: "ASSET-100",
    },
  },
};

const subscription = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Maintenance events",
  url: "https://hooks.example.test/opengmao",
  eventTypes: ["work_order.created"] as const,
  createdById: "manager-1",
  createdAt: new Date("2026-08-01T19:00:00.000Z"),
  revokedAt: null,
};

describe("webhook worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retryFailed.mockResolvedValue([]);
    mocks.listSubscriptions.mockResolvedValue([subscription]);
    mocks.listPendingEvents.mockResolvedValue([sourceEvent]);
    mocks.markProcessed.mockResolvedValue({ processed: true });
    mocks.deliveryId.mockReturnValue("delivery-1");
    mocks.deliveryFindFirst.mockResolvedValue(null);
    mocks.deliver.mockResolvedValue({ delivered: true, deliveryId: "delivery-1" });
  });

  it("delivers durable events older than the former 24-hour audit window", async () => {
    const now = new Date("2026-08-08T20:05:00.000Z");
    const result = await processWebhookQueue({ now });

    expect(result.processedEvents).toBe(1);
    expect(mocks.listPendingEvents).toHaveBeenCalledWith({
      direction: "OUTBOUND",
      channel: "webhook",
      limit: 200,
    });
    expect(mocks.deliver).toHaveBeenCalledWith({
      subscription,
      event: {
        id: sourceEvent.id,
        type: "work_order.created",
        createdAt: sourceEvent.occurredAt,
        data: sourceEvent.payload,
      },
      now,
    });
    expect(mocks.markProcessed).toHaveBeenCalledWith({ event: sourceEvent, processedAt: now });
  });

  it("does not redeliver an event that already has delivery state but still closes queue processing", async () => {
    mocks.deliveryFindFirst.mockResolvedValue({
      id: "audit-delivery",
      entityType: "WebhookDelivery",
      entityId: "delivery-1",
      action: "DELIVERED",
      createdAt: new Date(),
    });

    await processWebhookQueue({ now: new Date("2026-08-08T20:05:00.000Z") });

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });

  it("does not cross organization or site boundaries", async () => {
    mocks.listSubscriptions.mockResolvedValue([
      { ...subscription, siteId: "site-b" },
      { ...subscription, id: "sub-org-b", organizationId: "org-b" },
    ]);

    await processWebhookQueue({ now: new Date("2026-08-08T20:05:00.000Z") });

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });

  it("does not send historical events to subscriptions created after the event occurred", async () => {
    mocks.listSubscriptions.mockResolvedValue([
      { ...subscription, createdAt: new Date("2026-08-06T00:00:00.000Z") },
    ]);

    await processWebhookQueue({ now: new Date("2026-08-08T20:05:00.000Z") });

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });
});
