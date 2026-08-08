import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  httpsRequest: vi.fn(),
  resolveTarget: vi.fn(),
  signPayload: vi.fn(),
  auditCreate: vi.fn(),
  recordDeadLetter: vi.fn(),
  resolveDeadLetter: vi.fn(),
}));

vi.mock("node:https", () => ({ request: mocks.httpsRequest }));
vi.mock("@/lib/webhooks/security", () => ({
  resolvePublicWebhookTarget: mocks.resolveTarget,
  signWebhookPayload: mocks.signPayload,
}));
vi.mock("@/lib/integrations/dead-letter", () => ({
  recordIntegrationDeadLetter: mocks.recordDeadLetter,
  resolveIntegrationDeadLetter: mocks.resolveDeadLetter,
}));
vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      create: mocks.auditCreate,
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { deliverWebhook } from "@/lib/webhooks/delivery";
import type { WebhookSubscription } from "@/lib/webhooks/subscriptions";

const subscription: WebhookSubscription = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Maintenance events",
  url: "https://hooks.example.test/opengmao?source=gmao",
  eventTypes: ["work_order.created"],
  createdById: "manager-1",
  createdAt: new Date("2026-08-07T19:00:00.000Z"),
  revokedAt: null,
};

const event = {
  id: "audit-work-order-1",
  type: "work_order.created" as const,
  createdAt: "2026-08-07T20:00:00.000Z",
  data: { workOrder: { id: "wo-1", number: "WO-P-DEMO" } },
};

function mockRequestWithStatus(statusCode: number, headers: Record<string, string> = {}) {
  const request = {
    setTimeout: vi.fn(),
    once: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  };
  mocks.httpsRequest.mockImplementation((options, callback) => {
    callback({ statusCode, headers, resume: vi.fn() });
    return request;
  });
  return request;
}

describe("webhook delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockResolvedValue({
      url: new URL(subscription.url),
      address: "8.8.8.8",
      family: 4,
    });
    mocks.signPayload.mockReturnValue("a".repeat(64));
    mocks.auditCreate.mockResolvedValue({ id: "delivery-audit" });
    mocks.recordDeadLetter.mockResolvedValue({ id: "dead-letter-1" });
    mocks.resolveDeadLetter.mockResolvedValue(null);
  });

  it("posts to the validated IP while preserving TLS SNI and Host", async () => {
    const request = mockRequestWithStatus(204);
    const now = new Date("2026-08-07T20:05:00.000Z");

    const result = await deliverWebhook({ subscription, event, now });

    expect(result.delivered).toBe(true);
    expect(mocks.httpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "https:",
        hostname: "8.8.8.8",
        servername: "hooks.example.test",
        path: "/opengmao?source=gmao",
        method: "POST",
        headers: expect.objectContaining({
          Host: "hooks.example.test",
          "X-OpenGMAO-Event": "work_order.created",
          "X-OpenGMAO-Event-Id": "audit-work-order-1",
          "X-OpenGMAO-Signature": `v1=${"a".repeat(64)}`,
        }),
      }),
      expect.any(Function),
    );
    expect(request.end).toHaveBeenCalledWith(JSON.stringify(event));
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "DELIVERED" }),
    });
    expect(mocks.resolveDeadLetter).toHaveBeenCalledWith({
      organizationId: "org-a",
      channel: "webhook",
      sourceId: expect.any(String),
      now,
    });
  });

  it("persists a retryable failure for transient responses", async () => {
    mockRequestWithStatus(503);
    const now = new Date("2026-08-07T20:05:00.000Z");

    const result = await deliverWebhook({ subscription, event, now });

    expect(result.delivered).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.retryReason).toBe("http_status");
    expect(result.nextAttemptAt).toEqual(new Date("2026-08-07T20:06:00.000Z"));
    expect(mocks.recordDeadLetter).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "FAILED",
        afterJson: expect.stringContaining('"attempt":1'),
      }),
    });
  });

  it("honors Retry-After for throttled webhook endpoints", async () => {
    mockRequestWithStatus(429, { "retry-after": "120" });
    const now = new Date("2026-08-07T20:05:00.000Z");

    const result = await deliverWebhook({ subscription, event, now });

    expect(result.delivered).toBe(false);
    expect(result.retryReason).toBe("retry_after");
    expect(result.nextAttemptAt).toEqual(new Date("2026-08-07T20:07:00.000Z"));
  });

  it("dead-letters permanent client errors instead of retrying them", async () => {
    mockRequestWithStatus(400);
    const now = new Date("2026-08-07T20:05:00.000Z");

    const result = await deliverWebhook({ subscription, event, now });

    expect(result.delivered).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.retryReason).toBe("http_not_retryable");
    expect(result.nextAttemptAt).toBeNull();
    expect(result.deadLetterId).toBe("dead-letter-1");
    expect(mocks.recordDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        channel: "webhook",
        reason: "http_not_retryable",
        attempts: 1,
        statusCode: 400,
        payload: { subscriptionId: subscription.id, event },
      }),
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "DEAD_LETTERED",
        afterJson: expect.stringContaining('"deadLetterId":"dead-letter-1"'),
      }),
    });
  });

  it("dead-letters an exhausted transient retry chain", async () => {
    mockRequestWithStatus(503);
    const now = new Date("2026-08-07T20:05:00.000Z");

    const result = await deliverWebhook({ subscription, event, now, attempt: 5 });

    expect(result.delivered).toBe(false);
    expect(result.retryReason).toBe("attempt_limit");
    expect(result.nextAttemptAt).toBeNull();
    expect(mocks.recordDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "attempt_limit", attempts: 5, statusCode: 503 }),
    );
  });
});
