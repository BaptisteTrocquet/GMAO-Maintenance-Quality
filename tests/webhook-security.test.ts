import { afterEach, describe, expect, it } from "vitest";
import {
  deriveWebhookSigningSecret,
  isPublicWebhookIp,
  normalizeWebhookUrl,
  resolvePublicWebhookTarget,
  signWebhookPayload,
} from "@/lib/webhooks/security";

describe("webhook security", () => {
  afterEach(() => {
    delete process.env.WEBHOOK_SIGNING_MASTER_SECRET;
  });

  it("derives a stable per-subscription secret and HMAC signature", () => {
    process.env.WEBHOOK_SIGNING_MASTER_SECRET = "test-master-secret-with-at-least-32-characters";
    const secret = deriveWebhookSigningSecret("subscription-1");
    expect(secret).toMatch(/^whsec_/);
    expect(deriveWebhookSigningSecret("subscription-1")).toBe(secret);
    expect(deriveWebhookSigningSecret("subscription-2")).not.toBe(secret);

    const signature = signWebhookPayload({
      subscriptionId: "subscription-1",
      timestamp: "1786142400",
      body: '{"id":"evt-1","type":"work_order.created"}',
    });
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(
      signWebhookPayload({
        subscriptionId: "subscription-1",
        timestamp: "1786142400",
        body: '{"id":"evt-1","type":"work_order.created"}',
      }),
    ).toBe(signature);
  });

  it("rejects non-HTTPS, localhost and private/reserved literal targets", () => {
    expect(() => normalizeWebhookUrl("http://example.test/hook")).toThrow();
    expect(() => normalizeWebhookUrl("https://localhost/hook")).toThrow();
    expect(() => normalizeWebhookUrl("https://service.internal/hook")).toThrow();
    expect(() => normalizeWebhookUrl("https://127.0.0.1/hook")).toThrow();
    expect(() => normalizeWebhookUrl("https://10.0.0.5/hook")).toThrow();
    expect(() => normalizeWebhookUrl("https://169.254.169.254/latest/meta-data")).toThrow();
    expect(() => normalizeWebhookUrl("https://192.168.1.10/hook")).toThrow();
  });

  it("classifies public and reserved IP ranges conservatively", () => {
    expect(isPublicWebhookIp("8.8.8.8")).toBe(true);
    expect(isPublicWebhookIp("1.1.1.1")).toBe(true);
    expect(isPublicWebhookIp("192.0.2.10")).toBe(false);
    expect(isPublicWebhookIp("198.51.100.10")).toBe(false);
    expect(isPublicWebhookIp("203.0.113.10")).toBe(false);
    expect(isPublicWebhookIp("::1")).toBe(false);
    expect(isPublicWebhookIp("fc00::1")).toBe(false);
    expect(isPublicWebhookIp("2001:db8::1")).toBe(false);
  });

  it("can pin a public literal HTTPS endpoint without DNS lookup", async () => {
    const target = await resolvePublicWebhookTarget("https://8.8.8.8/webhook");
    expect(target.address).toBe("8.8.8.8");
    expect(target.family).toBe(4);
    expect(target.url.pathname).toBe("/webhook");
  });
});
