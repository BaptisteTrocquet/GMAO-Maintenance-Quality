# Production Docker image

The repository ships a production-oriented multi-stage Docker image for the Next.js application.

## Design

The final image:

- uses Node.js 22 on Debian Bookworm slim;
- runs the Next.js `standalone` server instead of the development server;
- contains only the standalone runtime, public assets, and Next.js static assets from the build stage;
- runs as the unprivileged `nextjs` user with UID `1001`;
- listens on port `3000` on `0.0.0.0`;
- disables Next.js telemetry;
- provides `/app/data` as the persistence boundary for the default local document storage provider;
- defaults `STORAGE_LOCAL_DIR` to `/app/data/documents`;
- does not copy `.env` files, local data, Git metadata, test output, coverage, or local `node_modules` into the build context.

The CI workflow builds the real image and verifies that the final container runs as UID `1001`, contains the standalone server, has writable local document storage, does not contain `/app/.env`, and runs with `NODE_ENV=production`.

## Build

```sh
docker build -t gmao-maintenance-quality:local .
```

No application secret should be passed as a Docker build argument or baked into the image. Runtime configuration belongs in environment variables or the platform's secret manager.

## Run

A minimal example using an existing PostgreSQL database is:

```sh
docker run --rm \
  --name gmao \
  -p 3000:3000 \
  -e DATABASE_URL='postgresql://user:password@db.example.internal:5432/gmao?schema=public' \
  -v gmao_documents:/app/data \
  gmao-maintenance-quality:local
```

For production, provide secrets through the container orchestrator or secret manager instead of writing them into the image or source-controlled environment files.

When `STORAGE_PROVIDER=s3`, configure the documented S3-compatible runtime variables and the `/app/data` volume is not required for controlled document persistence. When using the default local provider, `/app/data` must be backed by durable storage.

## Database migrations

The application container intentionally does **not** run database migrations on startup. Multiple replicas may start concurrently, and application startup is not a safe migration lock or release boundary.

Apply committed Prisma migrations as an explicit deployment step before promoting the new application version. The detailed production upgrade, forward/rollback, and release procedure is tracked separately in E14.

## Health probes

Dedicated health and readiness endpoints are a separate E14 story. Do not treat the presence of port `3000` alone as a readiness guarantee until those endpoints are implemented and wired into the deployment platform.

## Security boundary

The image runs non-root and the Docker build context excludes common local secret and generated-data paths. This story does not yet claim the E14 mandatory container vulnerability-scan check; vulnerability scanning is tracked separately and must be completed before that mandatory check is closed.
