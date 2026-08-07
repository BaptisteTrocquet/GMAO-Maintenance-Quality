import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  resolveTarget: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      findMany: mocks.auditFindMany,
      create: mocks.auditCreate,
    },
  },
}));
vi.mock("@/lib/webhooks/security", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/webhooks/security")>();
  return { ...original, resolvePublicWebhookTarget: mocks.resolveTarget };
});

import {
  createWebhookSubscription,
  getWebhookSubscription,
  revokeWebhookSubscription,
} from "@/lib/webhooks/subscriptions";

const createdAt = new Date("2026-08-07T20:00:00.000Z");

describe("webhook subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBHOOK_SIGNING_MASTER_SECRET = "test-master-secret-with-at-least-32-characters";
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.resolveTarget.mockResolvedValue({
      url: new URL("https://hooks.example.test/opengmao"),
      address: "8.8.8.8",
      family: 4,
    });
  });

  afterEach(() => {
    delete process.env.WEBHOOK_SIGNING_MASTER_SECRET;
  });

  it("returns the signing secret once and stores only subscription metadata in AuditLog", async () => {
    const result = await createWebhookSubscription({
      organizationId: "org-a",
      siteId: "site-a",
      name: "Maintenance events",
      url: "https://hooks.example.test/opengmao",
      eventTypes: ["work_order.created"],
      createdById: "manager-1",
    });

    expect(result.signingSecret).toMatch(/^whsec_/);
    expect(result.subscription).toMatchObject({
      organizationId: "org-a",
      siteId: "site-a",
      url: "https://hooks.example.test/opengmao",
      eventTypes: ["work_order.created"],
    });
    const createCall = mocks.auditCreate.mock.calls[0]?.[0];
    expect(createCall.data.action).toBe("CREATED");
    expect(createCall.data.entityType).toBe("WebhookSubscription");
    expect(createCall.data.afterJson).not.toContain("whsec_");
    expect(createCall.data.afterJson).toContain('"eventTypes":["work_order.created"]');
  });

  it("reconstructs and revokes a subscription from immutable audit entries", async () => {
    const afterJson = JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      name: "Maintenance events",
      url: "https://hooks.example.test/opengmao",
      eventTypes: ["work_order.created"],
      createdById: "manager-1",
    });
    mocks.auditFindMany.mockResolvedValueOnce([
      {
        id: "audit-created",
        actorId: "manager-1",
        entityType: "WebhookSubscription",
        entityId: "11111111-1111-4111-8111-111111111111",
        action: "CREATED",
        beforeJson: null,
        afterJson,
        createdAt,
      },
    ]);

    const subscription = await getWebhookSubscription("11111111-1111-4111-8111-111111111111");
    expect(subscription?.revokedAt).toBeNull();

    mocks.auditFindMany.mockResolvedValueOnce([
      {
        id: "audit-created",
        actorId: "manager-1",
        entityType: "WebhookSubscription",
        entityId: "11111111-1111-4111-8111-111111111111",
        action: "CREATED",
        beforeJson: null,
        afterJson,
        createdAt,
      },
    ]);
    const revoked = await revokeWebhookSubscription({
      subscriptionId: "11111111-1111-4111-8111-111111111111",
      organizationId: "org-a",
      siteId: "site-a",
      actorId: "manager-1",
    });

    expect(revoked).toBe(true);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "WebhookSubscription",
        entityId: "11111111-1111-4111-8111-111111111111",
        action: "REVOKED",
      }),
    });
  });
});
