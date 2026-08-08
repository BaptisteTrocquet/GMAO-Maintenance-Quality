export type RateLimitBucket = "public-write" | "public" | "server" | "application";

export type RateLimitConfig = {
  enabled: boolean;
  windowMs: number;
  maxKeys: number;
  trustedProxyHops: number;
  limits: Record<RateLimitBucket, number>;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

type Entry = {
  count: number;
  resetAt: number;
  lastSeenAt: number;
};

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_KEYS = 10_000;
const DEFAULT_LIMITS: Record<RateLimitBucket, number> = {
  "public-write": 30,
  public: 120,
  server: 600,
  application: 600,
};

const EXEMPT_PATHS = new Set(["/api/health", "/api/ready", "/api/metrics"]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

export function readRateLimitConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RateLimitConfig {
  return {
    enabled: parseBoolean(env.RATE_LIMIT_ENABLED, env.NODE_ENV === "production"),
    windowMs: DEFAULT_WINDOW_MS,
    maxKeys: parseInteger(env.RATE_LIMIT_MAX_KEYS, DEFAULT_MAX_KEYS, 100, 100_000),
    trustedProxyHops: parseInteger(env.RATE_LIMIT_TRUST_PROXY_HOPS, 0, 0, 10),
    limits: {
      "public-write": parseInteger(
        env.RATE_LIMIT_PUBLIC_WRITE_PER_MINUTE,
        DEFAULT_LIMITS["public-write"],
        1,
        100_000,
      ),
      public: parseInteger(
        env.RATE_LIMIT_PUBLIC_PER_MINUTE,
        DEFAULT_LIMITS.public,
        1,
        100_000,
      ),
      server: parseInteger(
        env.RATE_LIMIT_SERVER_PER_MINUTE,
        DEFAULT_LIMITS.server,
        1,
        100_000,
      ),
      application: parseInteger(
        env.RATE_LIMIT_DEFAULT_PER_MINUTE,
        DEFAULT_LIMITS.application,
        1,
        100_000,
      ),
    },
  };
}

export function classifyRateLimitRequest(
  pathname: string,
  method: string,
): RateLimitBucket | null {
  if (!pathname.startsWith("/api/")) return null;
  if (EXEMPT_PATHS.has(pathname)) return null;

  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "OPTIONS") return null;

  if (pathname.startsWith("/api/v1/public/") || pathname.startsWith("/api/v1/embed/")) {
    return SAFE_METHODS.has(normalizedMethod) ? "public" : "public-write";
  }
  if (pathname.startsWith("/api/v1/server/")) return "server";
  return "application";
}

function sanitizeAddress(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 64) return null;
  if (!/^[0-9a-fA-F:.%]+$/.test(normalized)) return null;
  return normalized.toLowerCase();
}

export function resolveRateLimitClient(input: {
  headers: Pick<Headers, "get">;
  directAddress?: string | null;
  trustedProxyHops: number;
}) {
  const directAddress = sanitizeAddress(input.directAddress);

  if (input.trustedProxyHops > 0) {
    const forwarded = input.headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((value) => sanitizeAddress(value));

    if (forwarded?.length) {
      const index = forwarded.length - input.trustedProxyHops;
      if (index >= 0) {
        const candidate = forwarded[index];
        if (candidate) return `ip:${candidate}`;
      }
    }

    const realIp = sanitizeAddress(input.headers.get("x-real-ip"));
    if (realIp) return `ip:${realIp}`;
  }

  if (directAddress) return `ip:${directAddress}`;

  // Fail safe: when no trusted client address is available all such requests share one bucket.
  // This avoids accepting spoofable forwarding headers merely to improve rate-limit precision.
  return "ip:unidentified";
}

export function rateLimitForBucket(config: RateLimitConfig, bucket: RateLimitBucket) {
  return config.limits[bucket];
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, Entry>();

  check(input: {
    key: string;
    limit: number;
    now?: number;
    windowMs?: number;
    maxKeys?: number;
  }): RateLimitDecision {
    const now = input.now ?? Date.now();
    const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
    const maxKeys = input.maxKeys ?? DEFAULT_MAX_KEYS;
    const limit = Math.max(1, Math.floor(input.limit));

    let entry = this.entries.get(input.key);
    if (!entry || now >= entry.resetAt) {
      if (!entry) this.ensureCapacity(now, maxKeys);
      entry = { count: 0, resetAt: now + windowMs, lastSeenAt: now };
      this.entries.set(input.key, entry);
    }

    entry.count += 1;
    entry.lastSeenAt = now;

    const remaining = Math.max(0, limit - entry.count);
    const allowed = entry.count <= limit;
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((entry.resetAt - now) / 1_000));

    return {
      allowed,
      limit,
      remaining,
      resetAt: entry.resetAt,
      retryAfterSeconds,
    };
  }

  reset() {
    this.entries.clear();
  }

  size() {
    return this.entries.size;
  }

  private ensureCapacity(now: number, maxKeys: number) {
    if (this.entries.size < maxKeys) return;

    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(key);
    }
    if (this.entries.size < maxKeys) return;

    const deleteCount = this.entries.size - maxKeys + 1;
    const oldest = [...this.entries.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
      .slice(0, deleteCount);
    for (const [key] of oldest) this.entries.delete(key);
  }
}

export function applyRateLimitHeaders(headers: Headers, decision: RateLimitDecision) {
  headers.set("RateLimit-Limit", String(decision.limit));
  headers.set("RateLimit-Remaining", String(decision.remaining));
  headers.set("RateLimit-Reset", String(Math.ceil(decision.resetAt / 1_000)));
  if (!decision.allowed) headers.set("Retry-After", String(decision.retryAfterSeconds));
}
