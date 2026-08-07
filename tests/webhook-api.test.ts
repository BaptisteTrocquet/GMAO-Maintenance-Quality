import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertSitePermission: vi.fn(),
  siteFindFirst: vi.fn(),
  listSubscriptions: vi.fn(),
  createSubscription: vi.fn(),
  revokeSubscription: vi.fn(),
  deriveSecret: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticate }));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: class AccessDeniedError extends Error {},
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/webhooks/registry", () => ({
  listScopedWebhookSubscriptions: mocks.listSubscriptions,
}));
vi.mock("@/lib/webhooks/subscriptions", () => ({
  WEBHOOK_EVENT_TYPES: ["work_order.created"],
  createWebhookSubscription: mocks.createSubscription,
  revokeWebhookSubscription: mocks.revokeSubscription,
}));
vi.mock("@/lib/webhooks/security", () => ({
  WebhookConfigurationError: class WebhookConfigurationError extends Error {},
  WebhookTargetError: class WebhookTargetError extends Error {},
  deriveWebhookSigningSecret: mocks.deriveSecret,
}));

import { DELETE, GET, POST } from "@/app/api/webhooks/route";

const scope = { organizationId: "org-a", role: "OWNER", allSites: true, siteIds: ["site-a"] };

describe("webhook subscription API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      session: { user: { id: "manager-1" } },
      tenant: { scope },
    });
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.listSubscriptions.mockResolvedValue([]);
    mocks.deriveSecret.mockReturnValue("whsec_configuration");
    mocks.createSubscription.mockResolvedValue({
      subscription: {
        id: "11111111-1111-4111-8111-111111111111",
        organizationId: "org-a",
        siteId: "site-a",
        name: "Maintenance events",
        url: "https://hooks.example.test/opengmao",
        eventTypes: ["work_order.created"],
        createdById: "manager-1",
        createdAt: new Date("2026-08-07T20:00:00.000Z"),
        revokedAt: null,
      },
      signingSecret: "whsec_secret-once",
    });
    mocks.revokeSubscription.mockResolvedValue(true);
  });

  it("creates a subscription only for a site manager and returns the signing secret once", async () => {
    const response = await POST(
      new Request("http://localhost/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          name: "Maintenance events",
          url: "https://hooks.example.test/opengmao",
          eventTypes: ["work_order.created"],
        }),
      }),
    );

    expect(response?.status).toBe(201);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(scope, "site-a", "site:manage");
    expect(mocks.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ createdById: "manager-1" }),
    );
    await expect(response?.json()).resolves.toMatchObject({
      data: { signingSecret: "whsec_secret-once" },
    });
  });

  it("lists subscription metadata without the signing secret", async () => {
    mocks.listSubscriptions.mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        organizationId: "org-a",
        siteId: "site-a",
        name: "Maintenance events",
        url: "https://hooks.example.test/opengmao",
        eventTypes: ["work_order.created"],
        createdById: "manager-1",
        createdAt: new Date("2026-08-07T20:00:00.000Z"),
        revokedAt: null,
      },
    ]);

    const response = await GET(
      new Request("http://localhost/api/webhooks?organizationId=org-a&siteId=site-a"),
    );
    const body = await response?.json();

    expect(response?.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("whsec_");
  });

  it("revokes only a subscription inside the requested org/site", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/webhooks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          subscriptionId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(mocks.revokeSubscription).toHaveBeenCalledWith({
      subscriptionId: "11111111-1111-4111-8111-111111111111",
      organizationId: "org-a",
      siteId: "site-a",
      actorId: "manager-1",
    });
  });
});
