import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ processQueue: vi.fn() }));
vi.mock("@/lib/webhooks/worker", () => ({ processWebhookQueue: mocks.processQueue }));

import { POST } from "@/app/api/internal/webhooks/process/route";

const secret = "worker-secret-with-at-least-32-characters";

describe("webhook worker trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBHOOK_WORKER_SECRET = secret;
    mocks.processQueue.mockResolvedValue({ retries: [], processedEvents: 2, deliveries: [] });
  });

  afterEach(() => {
    delete process.env.WEBHOOK_WORKER_SECRET;
  });

  it("requires the configured worker bearer secret", async () => {
    const response = await POST(
      new Request("http://localhost/api/internal/webhooks/process", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.processQueue).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid worker secret without processing the queue", async () => {
    const response = await POST(
      new Request("http://localhost/api/internal/webhooks/process", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-secret" },
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.processQueue).not.toHaveBeenCalled();
  });

  it("fails closed when the worker secret is not configured", async () => {
    delete process.env.WEBHOOK_WORKER_SECRET;

    const response = await POST(
      new Request("http://localhost/api/internal/webhooks/process", { method: "POST" }),
    );

    expect(response.status).toBe(503);
    expect(mocks.processQueue).not.toHaveBeenCalled();
  });
});
