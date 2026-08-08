import { describe, expect, it } from "vitest";
import {
  createRetryPolicy,
  parseRetryAfter,
  RetryPolicyError,
} from "@/lib/integrations/retry-policy";

const now = new Date("2026-08-08T09:00:00.000Z");

describe("integration retry policy", () => {
  it("schedules idempotent transient network failures", () => {
    const policy = createRetryPolicy({
      maxAttempts: 3,
      delaysMs: [1_000, 5_000],
      maxDelayMs: 10_000,
      jitterRatio: 0,
    });

    expect(
      policy.decide({ attempt: 1, idempotent: true, outcome: { kind: "network" }, now }),
    ).toEqual({
      retry: true,
      attempt: 1,
      nextAttempt: 2,
      reason: "network",
      delayMs: 1_000,
      nextAttemptAt: new Date("2026-08-08T09:00:01.000Z"),
    });
  });

  it("retries only the configured transient HTTP statuses", () => {
    const policy = createRetryPolicy({ jitterRatio: 0 });

    expect(
      policy.decide({
        attempt: 1,
        idempotent: true,
        outcome: { kind: "http", status: 503 },
        now,
      }),
    ).toMatchObject({ retry: true, reason: "http_status" });

    expect(
      policy.decide({
        attempt: 1,
        idempotent: true,
        outcome: { kind: "http", status: 400 },
        now,
      }),
    ).toEqual({ retry: false, attempt: 1, reason: "http_not_retryable" });
  });

  it("respects Retry-After seconds without retrying earlier than requested", () => {
    const policy = createRetryPolicy({
      delaysMs: [1_000],
      maxDelayMs: 5 * 60_000,
      jitterRatio: 0,
    });

    expect(
      policy.decide({
        attempt: 1,
        idempotent: true,
        outcome: { kind: "http", status: 429, retryAfter: "120" },
        now,
      }),
    ).toEqual({
      retry: true,
      attempt: 1,
      nextAttempt: 2,
      reason: "retry_after",
      delayMs: 120_000,
      nextAttemptAt: new Date("2026-08-08T09:02:00.000Z"),
    });
  });

  it("parses Retry-After HTTP dates and rejects malformed values", () => {
    expect(parseRetryAfter("Sat, 08 Aug 2026 09:03:00 GMT", now)).toBe(180_000);
    expect(parseRetryAfter("not-a-date", now)).toBeNull();
    expect(parseRetryAfter("-10", now)).toBeNull();
  });

  it("caps Retry-After at the policy maximum", () => {
    const policy = createRetryPolicy({
      delaysMs: [1_000],
      maxDelayMs: 30_000,
      jitterRatio: 0,
    });

    expect(
      policy.decide({
        attempt: 1,
        idempotent: true,
        outcome: { kind: "http", status: 503, retryAfter: "600" },
        now,
      }),
    ).toMatchObject({ retry: true, delayMs: 30_000 });
  });

  it("does not retry operations that are not explicitly idempotent", () => {
    const policy = createRetryPolicy({ jitterRatio: 0 });

    expect(
      policy.decide({ attempt: 1, idempotent: false, outcome: { kind: "network" }, now }),
    ).toEqual({ retry: false, attempt: 1, reason: "non_idempotent" });
  });

  it("stops at the configured attempt limit", () => {
    const policy = createRetryPolicy({
      maxAttempts: 2,
      delaysMs: [1_000],
      maxDelayMs: 1_000,
      jitterRatio: 0,
    });

    expect(
      policy.decide({ attempt: 2, idempotent: true, outcome: { kind: "network" }, now }),
    ).toEqual({ retry: false, attempt: 2, reason: "attempt_limit" });
  });

  it("never retries explicitly permanent outcomes", () => {
    const policy = createRetryPolicy({ jitterRatio: 0 });

    expect(
      policy.decide({ attempt: 1, idempotent: true, outcome: { kind: "permanent" }, now }),
    ).toEqual({ retry: false, attempt: 1, reason: "permanent" });
  });

  it("applies bounded jitter through an injectable random source", () => {
    const policy = createRetryPolicy(
      { delaysMs: [10_000], maxDelayMs: 20_000, jitterRatio: 0.25 },
      { random: () => 1 },
    );

    expect(
      policy.decide({ attempt: 1, idempotent: true, outcome: { kind: "network" }, now }),
    ).toMatchObject({ retry: true, delayMs: 12_500 });
  });

  it("rejects unsafe retry policy configuration", () => {
    expect(() => createRetryPolicy({ maxAttempts: 0 })).toThrow(RetryPolicyError);
    expect(() => createRetryPolicy({ delaysMs: [] })).toThrow(RetryPolicyError);
    expect(() => createRetryPolicy({ jitterRatio: 2 })).toThrow(RetryPolicyError);
  });
});
