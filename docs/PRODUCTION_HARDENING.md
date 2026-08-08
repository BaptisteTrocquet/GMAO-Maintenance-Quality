# Production environment hardening

This guide defines the minimum production posture for self-hosting GMAO Maintenance Quality. It complements `PRODUCTION_DOCKER.md`, the backup/restore runbooks, structured logging, operational probes, rate limiting, and `UPGRADING.md`.

The repository can verify image and configuration invariants, but the deployment platform remains responsible for network policy, TLS termination, secret delivery, Linux security options, database roles, storage IAM, resource limits, and monitoring access.

## 1. Network and TLS boundary

- Expose the application to users only through HTTPS.
- Terminate TLS at a controlled reverse proxy, ingress controller, or load balancer using certificates managed outside the application image.
- Redirect public HTTP to HTTPS at that edge.
- Prefer HSTS at the TLS-terminating edge once the hostname is permanently HTTPS-only.
- Do not expose PostgreSQL, object-storage administration endpoints, or internal restore targets to the public Internet.
- Keep `/api/health`, `/api/ready`, and `/api/metrics` reachable by the orchestrator/monitoring plane, but restrict them to internal monitoring networks when the platform supports it. They intentionally contain no tenant records, but they are still operational interfaces.

## 2. Reverse proxies and client addresses

Rate limiting trusts **zero proxy hops by default**. `RATE_LIMIT_TRUST_PROXY_HOPS=0` is the safe baseline because forwarded headers are spoofable unless a controlled proxy has replaced them.

When deploying behind a reverse proxy:

1. determine the exact number of trusted proxy hops;
2. ensure those proxies overwrite, rather than append untrusted client-supplied forwarding headers;
3. set `RATE_LIMIT_TRUST_PROXY_HOPS` to that exact topology;
4. retest rate limiting after any ingress topology change.

Do not set a positive value merely to obtain prettier client IPs. If no trusted address is available, the built-in limiter deliberately collapses callers into a shared `ip:unidentified` bucket rather than trusting spoofable headers.

The built-in fixed-window limiter is process-local. Multi-replica production deployments should additionally enforce distributed or ingress-level rate limits where consistent cross-replica quotas are required.

## 3. Runtime secrets

Secrets are runtime configuration, never image build inputs.

- Do not pass API keys, passwords, tokens, signing keys, connector vault keys, or object-storage credentials as Docker `ARG` values.
- Do not bake `.env` files into images.
- Inject secrets using the orchestrator's secret mechanism or a dedicated secret manager.
- Give secret files/volumes the narrowest readable permissions supported by the platform.
- Rotate credentials after suspected disclosure and as part of the organization's normal security policy.
- Keep current and previous connector-vault keys only for the documented rotation window; remove the previous key once all credentials have been re-saved under the new version.

`.env.example` is documentation only. Secret-like variables must remain empty there.

## 4. Authentication and identity

Application sessions are bearer credentials. Treat them with the same transport requirements as API keys:

- transmit them only over HTTPS;
- never place them in URLs, logs, analytics events, or support screenshots;
- revoke sessions when an account is disabled or access is withdrawn;
- keep organization/site authorization server-side; the presence of UI controls is not an authorization boundary.

For OIDC deployments:

- configure only the intended issuer, client ID, and JWKS endpoint;
- use HTTPS identity-provider metadata endpoints;
- review claims mapping before production rollout;
- keep provider client secrets, when required by a future adapter, outside the repository and image;
- do not broaden tenant membership merely because an external identity authenticated successfully.

## 5. Container runtime

The production image already runs as unprivileged user `nextjs` (UID 1001). Preserve that boundary.

At the orchestrator level, additionally prefer:

- `no-new-privileges`;
- dropping all Linux capabilities unless a proven requirement exists;
- no privileged containers;
- no host PID/network/filesystem namespaces unless explicitly justified;
- CPU and memory limits;
- a read-only root filesystem where the platform/application smoke test confirms compatibility;
- writable mounts only where required, notably `/app/data` for local controlled-document storage and any platform-provided temporary filesystem required by the runtime.

Do not run the application container as root to work around filesystem permission errors. Fix ownership/mount permissions instead.

## 6. Database

- Place PostgreSQL on a private network reachable only by required application/migration/backup components.
- Use encrypted database transport when the database service/network requires it.
- Use separate production credentials from local/demo credentials.
- Prefer distinct roles for application runtime and privileged migration/administration work when operationally feasible.
- Grant the runtime role only the database privileges it needs.
- Apply schema migrations as an explicit controlled deployment step with `prisma migrate deploy`; the application container must not mutate schema on startup.
- Follow `UPGRADING.md` for expand/backfill/contract and recovery decisions.

Never use `prisma db push` or `prisma migrate reset` against production.

## 7. Controlled-document storage

### Local provider

`/app/data` is the declared persistence boundary and `/app/data/documents` is the default production document path.

- mount it on durable storage;
- restrict access to the application runtime identity and backup tooling;
- keep backups outside the Docker build context;
- back up database state and document storage as one coordinated recovery point.

### S3-compatible provider

- scope credentials to the required bucket/prefix and operations;
- avoid account-wide administrator credentials;
- use TLS endpoints;
- enable the provider's encryption/versioning/retention capabilities when appropriate;
- follow the backup procedure's snapshot/version consistency requirements.

## 8. Logs and observability

Use the structured logger. Do not add direct dumps of request bodies, headers, environment variables, Prisma records, tokens, credentials, or controlled-document contents.

The logging layer redacts known sensitive keys and deliberately omits Error messages/stacks from production-safe payloads, but this is defense in depth rather than permission to log arbitrary objects.

Collect `/api/metrics` from a trusted monitoring network. Avoid adding organization, site, user, asset, work-order, API-key, or other unbounded/sensitive labels to Prometheus metrics.

## 9. Health and readiness

- `/api/health` is liveness and intentionally does not depend on PostgreSQL.
- `/api/ready` verifies database reachability and should gate traffic to a replica.
- Docker `HEALTHCHECK` uses liveness so a database outage does not cause every application container to be killed and restarted simultaneously.
- Configure the orchestrator's readiness probe against `/api/ready`.

Do not replace liveness with a dependency-heavy check.

## 10. Backup, restore, and upgrades

Before material upgrades:

1. run and verify the production backup procedure;
2. confirm restore capability and recovery ownership;
3. review committed migrations with `npm run upgrade:check`;
4. prefer backward-compatible expand/backfill/contract migrations;
5. deploy schema changes explicitly before or in the documented release sequence;
6. verify `/api/health`, `/api/ready`, `/api/metrics`, authentication and critical workflows after rollout.

Restore into an isolated target first when diagnosing or validating backups. Do not use restore as an ad-hoc substitute for forward migration.

## 11. CI and supply-chain posture

The repository CI uses read-only repository-content permissions and locked npm dependencies. Production image builds must continue to use the committed lockfile.

CI scans the **actual production image built in the same job** with Trivy. Both the GitHub Action commit and the Trivy scanner version are immutable/pinned by repository policy. The gate fails on fixed `CRITICAL` OS or library vulnerabilities; `ignore-unfixed` prevents an unavailable upstream fix from being mistaken for an operator-actionable patch.

A non-blocking or unfixed finding is still a security-review input. Operators should rebuild regularly to consume patched base images and review HIGH findings according to exposure and exploitability. Scanner exceptions must be explicit reviewed decisions, not silent removal of the gate.

The `npm run hardening:check` gate validates repository-controlled invariants including:

- non-root production runtime;
- standalone production output;
- persistent local-storage boundary;
- no secret-like Docker build arguments or baked secret environment values;
- exclusion of `.env`, backups, private keys, PEM material and `.npmrc` from Docker context;
- empty secret placeholders in `.env.example`;
- zero trusted proxy hops by default;
- fail-safe unidentified-client rate limiting;
- read-only GitHub Actions repository-content permission;
- pinned Trivy action and scanner version;
- scan of `gmao-maintenance-quality:ci` with a failing `CRITICAL` vulnerability threshold.

A repository check cannot prove runtime firewall, IAM, TLS, kernel, orchestrator, or cloud-account posture. Those controls must be reviewed in the target environment.

## Production sign-off checklist

Before exposing a deployment to users, confirm:

- HTTPS-only public access and controlled ingress;
- private PostgreSQL and storage administration surfaces;
- secrets injected at runtime and absent from images/logs;
- non-root container with hardened runtime security options;
- durable document storage and verified backups;
- exact trusted-proxy configuration;
- internal access policy for health/readiness/metrics;
- production database/storage least-privilege credentials;
- readiness and monitoring alerts configured;
- upgrade/recovery runbooks owned and tested;
- Trivy production-image scan green or any accepted non-blocking findings explicitly reviewed;
- `npm run hardening:check` and CI green for the deployed revision.
