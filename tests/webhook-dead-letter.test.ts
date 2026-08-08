import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDeadLetter: vi.fn(),
  listDeadLetters: vi.fn(),
  markReplayed: vi.fn(),
  getSubscription: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock("@/lib/integrations/dead-letter", () => ({
  getIntegrationDeadLetterForReplay: mocks.getDeadLetter,
  listOpenIntegrationDeadLetters: mocks.listDeadLetters,
  markIntegrationDeadLetterReplayed: mocks.markReplayed,
}));
vi.mock("@/lib/webhooks/delivery", () => ({
  deliverWebhook: mocks.deliver,
}));
vi.mock("@/lib/webhooks/subscriptions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/webhooks/subscriptions")>();
  return { ...original, getWebhookSubscription: mocks.getSubscription };
});

import {
  listWebhookDeadLetters,
  replayWebhookDeadLetter,
} from "@/lib/webhooks/dead-letters";

const event = {
  id: "event-1",
  type: "work_order.created" as const,
  createdAt: "2026-08-08T09:00:00.000Z",
  data: { workOrder: { id: "wo-1" } },
};

const subscription = {
  id: "sub-1",
  organizationId: "org-a",
  siteId: "site-a",
  name: "ERP hook",
  url: "https://hooks.example.test/gmao",
  eventTypes: ["work_order.created"] as const,
  createdById: "manager-1",
  createdAt: new Date("2026-08-08T08:00:00.000Z"),
  revokedAt: null,
};

describe("webhook dead letters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDeadLetters.mockResolvedValue([{ id: "dlq-1" }]);
    mocks.getDeadLetter.mockResolvedValue({
      metadata: { id: "dlq-1" },
      payload: { subscriptionId: "sub-1", event },
    });
    mocks.getSubscription.mockResolvedValue(subscription);
    mocks.markReplayed.mockResolvedValue({ id: "dlq-1", replayCount: 1 });
    mocks.deliver.mockResolvedValue({ delivered: true, deliveryId: "delivery-1", attempt: 1 });
  });

  it("lists only webhook dead letters in the selected site scope", async () => {
    await expect(
      listWebhookDeadLetters({ organizationId: "org-a", siteId: "site-a", limit: 50 }),
    ).resolves.toEqual([{ id: "dlq-1" }]);
    expect(mocks.listDeadLetters).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      channel: "webhook",
      limit: 50,
    });
  });

  it("replays the original event with the same event id and a fresh retry budget", async () => {
    const now = new Date("2026-08-08T09:30:00.000Z");
    const result = await replayWebhookDeadLetter({
      organizationId: "org-a",
      siteId: "site-a",
      deadLetterId: "dlq-1",
      actorId: "manager-1",
      now,
    });

    expect(result.delivered).toBe(true);
    expect(mocks.getDeadLetter).toHaveBeenCalledWith({
      id: "dlq-1",
      organizationId: "org-a",
      siteId: "site-a",
      channel: "webhook",
    });
    expect(mocks.markReplayed).toHaveBeenCalledWith({
      id: "dlq-1",
      organizationId: "org-a",
      siteId: "site-a",
      actorId: "manager-1",
      now,
    });
    expect(mocks.deliver).toHaveBeenCalledWith({
      subscription,
      event,
      attempt: 1,
      now,
    });
  });

  it("rejects replay when the stored subscription no longer belongs to the tenant", async () => {
    mocks.getSubscription.mockResolvedValue({ ...subscription, organizationId: "org-b" });

    await expect(
      replayWebhookDeadLetter({
        organizationId: "org-a",
        siteId: "site-a",
        deadLetterId: "dlq-1",
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SUBSCRIPTION_UNAVAILABLE",
    });
    expect(mocks.markReplayed).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("rejects malformed persisted replay payloads before delivery", async () => {
    mocks.getDeadLetter.mockResolvedValue({
      metadata: { id: "dlq-1" },
      payload: { subscriptionId: "sub-1", event: { id: "event-1", type: "unknown" } },
    });

    await expect(
      replayWebhookDeadLetter({
        organizationId: "org-a",
        siteId: "site-a",
        deadLetterId: "dlq-1",
        actorId: "manager-1",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_WEBHOOK_DEAD_LETTER",
    });
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
