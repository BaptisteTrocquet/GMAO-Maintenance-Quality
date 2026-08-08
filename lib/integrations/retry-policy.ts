const DEFAULT_DELAYS_MS = [1_000, 5_000, 30_000, 2 * 60_000] as const;
const DEFAULT_RETRYABLE_HTTP_STATUSES = [408, 425, 429, 500, 502, 503, 504] as const;

export type RetryOutcome =
  | { kind: "success" }
  | { kind: "network" }
  | { kind: "permanent" }
  | { kind: "http"; status: number; retryAfter?: string | null };

export type RetryStopReason =
  | "success"
  | "attempt_limit"
  | "non_idempotent"
  | "permanent"
  | "http_not_retryable";

export type RetryReason = "network" | "http_status" | "retry_after";

export type RetryDecision =
  | {
      retry: false;
      attempt: number;
      reason: RetryStopReason;
    }
  | {
      retry: true;
      attempt: number;
      nextAttempt: number;
      reason: RetryReason;
      delayMs: number;
      nextAttemptAt: Date;
    };

export type RetryPolicyConfig = {
  maxAttempts?: number;
  delaysMs?: readonly number[];
  maxDelayMs?: number;
  jitterRatio?: number;
  retryableHttpStatuses?: readonly number[];
};

export type RetryPolicyOptions = {
  random?: () => number;
};

export class RetryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryPolicyError";
  }
}

function validateInteger(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RetryPolicyError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function validateConfig(config: RetryPolicyConfig) {
  const maxAttempts = config.maxAttempts ?? 5;
  validateInteger(maxAttempts, "maxAttempts", 1, 20);

  const delaysMs = [...(config.delaysMs ?? DEFAULT_DELAYS_MS)];
  if (delaysMs.length === 0) {
    throw new RetryPolicyError("delaysMs must contain at least one delay");
  }
  for (const delay of delaysMs) {
    validateInteger(delay, "retry delay", 0, 24 * 60 * 60 * 1000);
  }

  const maxDelayMs = config.maxDelayMs ?? Math.max(...delaysMs);
  validateInteger(maxDelayMs, "maxDelayMs", 1, 24 * 60 * 60 * 1000);

  const jitterRatio = config.jitterRatio ?? 0.2;
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RetryPolicyError("jitterRatio must be between 0 and 1");
  }

  const retryableHttpStatuses = new Set(
    config.retryableHttpStatuses ?? DEFAULT_RETRYABLE_HTTP_STATUSES,
  );
  for (const status of retryableHttpStatuses) {
    validateInteger(status, "retryable HTTP status", 100, 599);
  }

  return { maxAttempts, delaysMs, maxDelayMs, jitterRatio, retryableHttpStatuses };
}

export function parseRetryAfter(value: string | null | undefined, now = new Date()) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return null;
    return seconds * 1_000;
  }
  if (/^[+-]\d+$/.test(trimmed)) return null;

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now.getTime());
}

function clampRandom(value: number) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export function createRetryPolicy(
  config: RetryPolicyConfig = {},
  options: RetryPolicyOptions = {},
) {
  const normalized = validateConfig(config);
  const random = options.random ?? Math.random;

  function scheduleDelay(attempt: number, retryAfter: string | null | undefined, now: Date) {
    const index = Math.min(attempt - 1, normalized.delaysMs.length - 1);
    const configuredDelay = normalized.delaysMs[index] ?? normalized.delaysMs.at(-1) ?? 0;
    const jitterFactor =
      normalized.jitterRatio === 0
        ? 1
        : 1 - normalized.jitterRatio + 2 * normalized.jitterRatio * clampRandom(random());
    const jitteredDelay = Math.round(configuredDelay * jitterFactor);
    const serverDelay = parseRetryAfter(retryAfter, now);
    return Math.min(normalized.maxDelayMs, Math.max(jitteredDelay, serverDelay ?? 0));
  }

  return {
    maxAttempts: normalized.maxAttempts,
    decide(input: {
      attempt: number;
      idempotent: boolean;
      outcome: RetryOutcome;
      now?: Date;
    }): RetryDecision {
      validateInteger(input.attempt, "attempt", 1, normalized.maxAttempts);
      const now = input.now ?? new Date();

      if (input.outcome.kind === "success") {
        return { retry: false, attempt: input.attempt, reason: "success" };
      }
      if (input.attempt >= normalized.maxAttempts) {
        return { retry: false, attempt: input.attempt, reason: "attempt_limit" };
      }
      if (!input.idempotent) {
        return { retry: false, attempt: input.attempt, reason: "non_idempotent" };
      }
      if (input.outcome.kind === "permanent") {
        return { retry: false, attempt: input.attempt, reason: "permanent" };
      }
      if (
        input.outcome.kind === "http" &&
        !normalized.retryableHttpStatuses.has(input.outcome.status)
      ) {
        return { retry: false, attempt: input.attempt, reason: "http_not_retryable" };
      }

      const retryAfter = input.outcome.kind === "http" ? input.outcome.retryAfter : null;
      const delayMs = scheduleDelay(input.attempt, retryAfter, now);
      return {
        retry: true,
        attempt: input.attempt,
        nextAttempt: input.attempt + 1,
        reason:
          input.outcome.kind === "network"
            ? "network"
            : parseRetryAfter(retryAfter, now) !== null
              ? "retry_after"
              : "http_status",
        delayMs,
        nextAttemptAt: new Date(now.getTime() + delayMs),
      };
    },
  };
}

export const defaultIntegrationRetryPolicy = createRetryPolicy();
