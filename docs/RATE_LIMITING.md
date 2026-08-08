# Production rate limiting

The application has a dependency-free API rate-limit boundary in `middleware.ts` backed by `lib/rate-limit.ts`.

Rate limiting is a resilience and abuse-control layer. It is **not** an authorization control: tenant, site, membership, origin, token and API-key checks remain mandatory in their existing server-side boundaries.

## Default behavior

Rate limiting is enabled by default when `NODE_ENV=production` and disabled by default in development/test environments. Operators can explicitly override that behavior with `RATE_LIMIT_ENABLED`.

The default one-minute budgets are:

| Surface | Default |
| --- | ---: |
| public/embed writes | 30 requests/minute/client |
| public/embed reads | 120 requests/minute/client |
| server API (`/api/v1/server/*`) | 600 requests/minute/client |
| other application API routes | 600 requests/minute/client |

CORS `OPTIONS` requests are not counted. The operational endpoints `/api/health`, `/api/ready` and `/api/metrics` are exempt so overload protection cannot make liveness/readiness/monitoring disappear during an incident.

A rejected request returns HTTP `429` with stable API error code `RATE_LIMITED`, `Cache-Control: no-store`, quota metadata and `Retry-After`.

Successful limited requests also receive:

- `RateLimit-Limit`
- `RateLimit-Remaining`
- `RateLimit-Reset`

## Configuration

```text
RATE_LIMIT_ENABLED=true
RATE_LIMIT_PUBLIC_WRITE_PER_MINUTE=30
RATE_LIMIT_PUBLIC_PER_MINUTE=120
RATE_LIMIT_SERVER_PER_MINUTE=600
RATE_LIMIT_DEFAULT_PER_MINUTE=600
RATE_LIMIT_MAX_KEYS=10000
RATE_LIMIT_TRUST_PROXY_HOPS=0
```

Invalid/out-of-range numeric values fall back to bounded defaults instead of silently disabling protection.

`RATE_LIMIT_MAX_KEYS` bounds the in-process client-key map. Expired keys are removed first; if capacity is still reached, the least-recently-seen entry is evicted. This prevents arbitrary client identifiers from causing unbounded memory growth.

## Client address and trusted proxies

Forwarded client headers are attacker-controlled unless the application is definitely behind a controlled reverse proxy.

Therefore the application **does not trust `X-Forwarded-For` or `X-Real-IP` by default**. `RATE_LIMIT_TRUST_PROXY_HOPS=0` uses a direct runtime address when one is supplied by the platform. If no trusted address is available, requests share the fail-safe `unidentified` bucket rather than accepting a spoofable address.

When the application is behind a known proxy chain, set `RATE_LIMIT_TRUST_PROXY_HOPS` to the exact number of trusted hops between the client and the application. For example, a deployment with one controlled ingress that supplies the client address should use `1`.

The ingress must overwrite/sanitize forwarding headers from untrusted clients. Do not enable trusted proxy hops merely because an `X-Forwarded-For` header exists.

## Replica semantics

The built-in limiter is intentionally in-process and dependency-free. Each application replica owns its own fixed-window counters.

That is appropriate for:

- a single self-hosted application container;
- a defense-in-depth limiter behind an ingress;
- local/on-prem deployments where adding a distributed cache solely for quotas is undesirable.

For a multi-replica production deployment that requires a **global** request budget, enforce a shared limiter at the reverse proxy/API gateway/load balancer (or replace the limiter with a shared backend). Keep the application limiter enabled as a second line of defense where practical.

Do not assume multiplying the per-replica quota by replica count gives a security guarantee: load balancing and replica churn make that model approximate.

## Privacy and logging

The limiter does not log client addresses, forwarding headers, API keys, browser tokens, cookies, paths with query strings, request bodies or rejected payloads. It only makes an in-memory decision.

This avoids turning abuse protection into a new source of sensitive operational logs. If ingress-level rate-limit telemetry is enabled, apply the repository's structured-log redaction and retention rules there as well.

## Failure behavior

The limiter fails safe:

- untrusted forwarding headers are ignored;
- no trusted address means a shared bucket rather than a caller-controlled bucket;
- invalid configuration falls back to bounded defaults;
- the number of stored keys is bounded;
- health/readiness/metrics stay observable;
- authorization still executes normally for requests that remain within quota.

Rate limiting never grants access and does not replace idempotency. A request that can be retried still needs the domain's existing idempotence guarantees.