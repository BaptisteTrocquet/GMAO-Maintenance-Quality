# Production Docker image

The repository ships a production-oriented multi-stage Docker image for the Next.js application.

## Design

The final `runner` image:

- uses Node.js 22 on Debian Bookworm slim;
- runs the Next.js `standalone` server instead of the development server;
- contains only the standalone runtime, public assets, and Next.js static assets from the build stage;
- runs as the unprivileged `nextjs` user with UID `1001`;
- listens on port `3000` on `0.0.0.0`;
- disables Next.js telemetry;
- provides `/app/data` as the persistence boundary for the default local document storage provider;
- defaults `STORAGE_LOCAL_DIR` to `/app/data/documents`;
- does not copy `.env` files, local data, Git metadata, test output, coverage, or host `node_modules` into the build context;
- removes the global npm/Corepack/Yarn package-manager toolchain from the final runtime after the application is built.

The long-running production process is `node server.js`. Package managers and Prisma migration tooling are release/build concerns, not application-runtime dependencies.

## Build

Build the hardened application runtime explicitly from the `runner` target:

```sh
docker build --target runner -t gmao-maintenance-quality:local .
```

No application secret should be passed as a Docker build argument or baked into the image. Runtime configuration belongs in environment variables or the platform's secret manager.

For a complete Docker Compose or Kubernetes release sequence, including the separate migration image/job, see [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Run

A minimal example using an existing PostgreSQL database is:

```sh
docker run --rm \
  --name gmao \
  -p 127.0.0.1:3000:3000 \
  -e DATABASE_URL="$DATABASE_URL" \
  -v gmao_documents:/app/data \
  gmao-maintenance-quality:local
```

Inject `DATABASE_URL` and other secrets at runtime through the deployment platform. Do not write them into the image or source-controlled environment files.

When `STORAGE_PROVIDER=s3`, configure the documented S3-compatible runtime variables and the `/app/data` volume is not required for controlled document persistence. When using the default local provider, `/app/data` must be backed by durable storage and included in coordinated backup/recovery planning with PostgreSQL.

## Database migrations

The application container intentionally does **not** run database migrations on startup. Multiple replicas may start concurrently, and application startup is not a safe migration lock or release boundary.

Apply committed Prisma migrations as an explicit controlled release step before promoting the new application version. The final `runner` image intentionally cannot run `npm run prisma:deploy` because package-manager tooling is absent. Use the separate migration-job pattern in `DEPLOYMENT.md` or an equivalent controlled release environment that contains the repository's Prisma CLI and committed migrations.

Follow [`UPGRADING.md`](UPGRADING.md) for expand/backfill/contract, backup, compatibility, rollback and forward-fix decisions. Never use `prisma db push` or `prisma migrate reset` against production.

## Health and readiness

The production image has a Docker `HEALTHCHECK` against `GET /api/health`.

- `/api/health` is dependency-free liveness. It answers whether the application process is responsive.
- `/api/ready` checks required PostgreSQL reachability and is the traffic-admission signal.
- `/api/metrics` exposes bounded Prometheus-format operational metrics and should normally remain on a trusted monitoring path.

Do not replace liveness with readiness: a transient database outage should remove a replica from traffic without creating a container restart loop.

See [`HEALTH_READINESS.md`](HEALTH_READINESS.md) and [`APPLICATION_METRICS.md`](APPLICATION_METRICS.md).

## Security boundary

The application image runs non-root, excludes common secret/generated-data paths from the Docker context, and removes build-only package-manager tooling from the final filesystem. [`PRODUCTION_HARDENING.md`](PRODUCTION_HARDENING.md) defines the required runtime posture for TLS, trusted proxies, secrets, database/storage isolation, Linux security options and observability.

CI builds the actual production image and scans that same image with pinned Trivy tooling. Fixed `CRITICAL` OS or library vulnerabilities fail the build. CI also verifies the non-root runtime contract, health/readiness behavior, metrics and rate limiting.

A green repository scan does not replace target-environment review of firewalling, IAM, TLS, kernel/orchestrator settings, storage permissions, resource limits or secret delivery.
