import { describe, expect, it } from "vitest";
import {
  FixedWindowRateLimiter,
  applyRateLimitHeaders,
  classifyRateLimitRequest,
  readRateLimitConfig,
  resolveRateLimitClient,
} from "@/lib/rate-limit";

describe("production rate limiting", () => {
  it("defaults to enabled only in production with bounded policy defaults", () => {
    expect(readRateLimitConfig({ NODE_ENV: "production" })).toMatchObject({
      enabled: true,
      windowMs: 60_000,
      maxKeys: 10_000,
      trustedProxyHops: 0,
      limits: {
        "public-write": 30,
        public: 120,
        server: 600,
        application: 600,
      },
    });
    expect(readRateLimitConfig({ NODE_ENV: "test" }).enabled).toBe(false);
    expect(readRateLimitConfig({ NODE_ENV: "production", RATE_LIMIT_ENABLED: "false" }).enabled).toBe(
      false,
    );
  });

  it("accepts bounded operator overrides and rejects unsafe invalid values", () => {
    const config = readRateLimitConfig({
      NODE_ENV: "production",
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_TRUST_PROXY_HOPS: "2",
      RATE_LIMIT_MAX_KEYS: "2000",
      RATE_LIMIT_PUBLIC_WRITE_PER_MINUTE: "12",
      RATE_LIMIT_PUBLIC_PER_MINUTE: "90",
      RATE_LIMIT_SERVER_PER_MINUTE: "450",
      RATE_LIMIT_DEFAULT_PER_MINUTE: "300",
    });

    expect(config).toMatchObject({
      trustedProxyHops: 2,
      maxKeys: 2_000,
      limits: {
        "public-write": 12,
        public: 90,
        server: 450,
        application: 300,
      },
    });

    const invalid = readRateLimitConfig({
      NODE_ENV: "production",
      RATE_LIMIT_TRUST_PROXY_HOPS: "999",
      RATE_LIMIT_MAX_KEYS: "1",
      RATE_LIMIT_PUBLIC_WRITE_PER_MINUTE: "0",
    });
    expect(invalid.trustedProxyHops).toBe(0);
    expect(invalid.maxKeys).toBe(10_000);
    expect(invalid.limits["public-write"]).toBe(30);
  });

  it("classifies API surfaces while keeping operational probes and preflight exempt", () => {
    expect(classifyRateLimitRequest("/api/health", "GET")).toBeNull();
    expect(classifyRateLimitRequest("/api/ready", "GET")).toBeNull();
    expect(classifyRateLimitRequest("/api/metrics", "GET")).toBeNull();
    expect(classifyRateLimitRequest("/api/v1/public/assets", "OPTIONS")).toBeNull();
    expect(classifyRateLimitRequest("/api/v1/public/assets", "GET")).toBe("public");
    expect(classifyRateLimitRequest("/api/v1/embed/maintenance-requests", "POST")).toBe(
      "public-write",
    );
    expect(classifyRateLimitRequest("/api/v1/server/assets", "GET")).toBe("server");
    expect(classifyRateLimitRequest("/api/work-orders", "POST")).toBe("application");
    expect(classifyRateLimitRequest("/maintenance", "GET")).toBeNull();
  });

  it("ignores spoofable forwarding headers until a proxy hop count is explicitly trusted", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.10, 10.0.0.5",
      "x-real-ip": "198.51.100.7",
    });

    expect(
      resolveRateLimitClient({ headers, directAddress: "192.0.2.5", trustedProxyHops: 0 }),
    ).toBe("ip:192.0.2.5");
    expect(resolveRateLimitClient({ headers, directAddress: null, trustedProxyHops: 1 })).toBe(
      "ip:10.0.0.5",
    );
    expect(resolveRateLimitClient({ headers, directAddress: null, trustedProxyHops: 2 })).toBe(
      "ip:203.0.113.10",
    );
  });

  it("uses a shared fail-safe bucket when no trusted client address exists", () => {
    const headers = new Headers({ "x-forwarded-for": "attacker-controlled.example" });
    expect(resolveRateLimitClient({ headers, directAddress: null, trustedProxyHops: 0 })).toBe(
      "ip:unidentified",
    );
  });

  it("returns a deterministic 429 decision after the configured fixed-window budget", () => {
    const limiter = new FixedWindowRateLimiter();
    const first = limiter.check({ key: "public:client-a", limit: 2, now: 1_000, windowMs: 60_000 });
    const second = limiter.check({ key: "public:client-a", limit: 2, now: 2_000, windowMs: 60_000 });
    const third = limiter.check({ key: "public:client-a", limit: 2, now: 3_000, windowMs: 60_000 });

    expect(first).toMatchObject({ allowed: true, remaining: 1, resetAt: 61_000 });
    expect(second).toMatchObject({ allowed: true, remaining: 0, resetAt: 61_000 });
    expect(third).toMatchObject({ allowed: false, remaining: 0, resetAt: 61_000 });
    expect(third.retryAfterSeconds).toBe(58);

    expect(
      limiter.check({ key: "public:client-a", limit: 2, now: 61_000, windowMs: 60_000 }),
    ).toMatchObject({ allowed: true, remaining: 1, resetAt: 121_000 });
  });

  it("keeps client buckets isolated and bounds memory by evicting the oldest key", () => {
    const limiter = new FixedWindowRateLimiter();
    limiter.check({ key: "a", limit: 2, now: 1, maxKeys: 2 });
    limiter.check({ key: "b", limit: 2, now: 2, maxKeys: 2 });
    limiter.check({ key: "c", limit: 2, now: 3, maxKeys: 2 });

    expect(limiter.size()).toBe(2);
    expect(limiter.check({ key: "a", limit: 2, now: 4, maxKeys: 2 })).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("emits standard quota metadata and Retry-After only when blocked", () => {
    const allowedHeaders = new Headers();
    applyRateLimitHeaders(allowedHeaders, {
      allowed: true,
      limit: 10,
      remaining: 9,
      resetAt: 61_000,
      retryAfterSeconds: 0,
    });
    expect(allowedHeaders.get("ratelimit-limit")).toBe("10");
    expect(allowedHeaders.get("ratelimit-remaining")).toBe("9");
    expect(allowedHeaders.get("retry-after")).toBeNull();

    const blockedHeaders = new Headers();
    applyRateLimitHeaders(blockedHeaders, {
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: 61_000,
      retryAfterSeconds: 12,
    });
    expect(blockedHeaders.get("retry-after")).toBe("12");
  });
});
