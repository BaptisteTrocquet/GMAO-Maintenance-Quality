import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertSitePermission: vi.fn(),
  listDeadLetters: vi.fn(),
  replayDeadLetter: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticate }));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: class AccessDeniedError extends Error {},
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/webhooks/dead-letters", () => ({
  WebhookDeadLetterError: class WebhookDeadLetterError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  listWebhookDeadLetters: mocks.listDeadLetters,
  replayWebhookDeadLetter: mocks.replayDeadLetter,
}));
vi.mock("@/lib/integrations/dead-letter", () => ({
  IntegrationDeadLetterError: class IntegrationDeadLetterError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

import { GET, POST } from "@/app/api/integrations/dead-letters/webhooks/route";

const scope = {
  organizationId: "org-a",
  role: "OWNER",
  allSites: true,
  siteIds: ["site-a"],
};

function authResult() {
  return {
    session: { user: { id: "manager-1" } },
    tenant: { scope },
  };
}

describe("webhook dead-letter API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue(authResult());
    mocks.listDeadLetters.mockResolvedValue([
      {
        id: "dlq-1",
        organizationId: "org-a",
        siteId: "site-a",
        channel: "webhook",
        sourceId: "delivery-1",
        reason: "attempt_limit",
        attempts: 5,
        statusCode: 503,
        errorCode: "HTTP_DELIVERY_ERROR",
        replayCount: 0,
        lastReplayedAt: null,
        resolvedAt: null,
        createdAt: new Date("2026-08-08T09:00:00.000Z"),
        updatedAt: new Date("2026-08-08T09:00:00.000Z"),
      },
    ]);
    mocks.replayDeadLetter.mockResolvedValue({
      delivered: true,
      deliveryId: "delivery-1",
      attempt: 1,
      statusCode: 204,
    });
  });

  it("requires site management before listing dead-letter metadata", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/integrations/dead-letters/webhooks?organizationId=org-a&siteId=site-a",
      ),
    );

    expect(response?.status).toBe(200);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(scope, "site-a", "site:manage");
    expect(mocks.listDeadLetters).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      limit: undefined,
    });
    expect(JSON.stringify(await response?.json())).not.toContain("payloadJson");
  });

  it("replays only after site management authorization and attributes the actor", async () => {
    const response = await POST(
      new Request("http://localhost/api/integrations/dead-letters/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          deadLetterId: "dlq-1",
        }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(scope, "site-a", "site:manage");
    expect(mocks.replayDeadLetter).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      deadLetterId: "dlq-1",
      actorId: "manager-1",
    });
  });

  it("does not touch dead-letter data when authentication fails", async () => {
    mocks.authenticate.mockResolvedValue({ error: new Response(null, { status: 401 }) });

    const response = await GET(
      new Request(
        "http://localhost/api/integrations/dead-letters/webhooks?organizationId=org-a&siteId=site-a",
      ),
    );

    expect(response?.status).toBe(401);
    expect(mocks.assertSitePermission).not.toHaveBeenCalled();
    expect(mocks.listDeadLetters).not.toHaveBeenCalled();
  });
});
