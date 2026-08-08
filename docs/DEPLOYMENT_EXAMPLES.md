# Production deployment examples

The `deploy/` directory contains reference deployments for operators who want to self-host GMAO Maintenance Quality without weakening the production boundaries established by E14.

These files are **examples, not turnkey secret bundles**. Replace image placeholders, storage classes, resource limits, DNS/TLS configuration and secret delivery with values owned by your environment. Never commit real passwords, tokens, organization data, employee data, equipment identifiers or internal documents into this public repository.

## Shared production rules

Both examples assume:

- application and migration images are built from the **same reviewed release source**;
- production images are referenced by an immutable release tag or, preferably, a registry digest;
- secrets are injected at runtime rather than baked into an image or source-controlled manifest;
- Prisma migrations are an explicit release step and never run automatically when every application replica starts;
- `/api/health` is liveness and `/api/ready` is database-aware readiness;
- local document storage persists `/app/data`; S3-compatible storage can replace that persistence model;
- the application runs non-root and without extra Linux capabilities;
- public TLS termination is provided by a controlled reverse proxy/ingress outside these examples;
- monitoring access to `/api/metrics` is restricted by the deployment network/platform.

Read these runbooks before production rollout:

- `docs/PRODUCTION_DOCKER.md`
- `docs/PRODUCTION_HARDENING.md`
- `docs/HEALTH_READINESS.md`
- `docs/BACKUP.md`
- `docs/RESTORE.md`
- `docs/UPGRADING.md`
- `docs/RATE_LIMITING.md`
- `docs/STRUCTURED_LOGGING.md`
- `docs/APPLICATION_METRICS.md`

## Docker Compose example

File: `deploy/compose/docker-compose.production.yml`

The example includes one PostgreSQL service, one explicit migration service and one application service. PostgreSQL has **no host port**, while the application binds to `127.0.0.1` by default so a local TLS reverse proxy can be the public boundary.

### Build and publish the two release images

The runtime image is the hardened `runner` target. The migration tooling image deliberately uses the `builder` target because the runtime image no longer contains npm, Prisma CLI or build tooling.

```sh
docker build --target runner -t registry.example.invalid/opengmao:<release> .
docker build --target builder -t registry.example.invalid/opengmao-migrations:<release> .
```

Publish the images with your normal registry workflow, then resolve their immutable digests. Set these variables **outside source control**:

```text
OPENGMAO_IMAGE=registry.example.invalid/opengmao@sha256:<digest>
OPENGMAO_MIGRATION_IMAGE=registry.example.invalid/opengmao-migrations@sha256:<digest>
POSTGRES_IMAGE=registry.example.invalid/postgres@sha256:<reviewed-digest>
DATABASE_URL=<runtime secret>
POSTGRES_PASSWORD=<runtime secret>
```

The sample intentionally has no mutable image fallback. Missing image variables stop Compose rather than silently pulling an unreviewed tag.

### Release sequence

1. Verify/produce a backup following `docs/BACKUP.md`.
2. Run `npm run upgrade:check` against the reviewed source revision.
3. Start or verify PostgreSQL.
4. Run the one-shot migration profile.
5. Start/update the application.
6. Check liveness, readiness and metrics.

Example commands:

```sh
docker compose -f deploy/compose/docker-compose.production.yml up -d db
docker compose -f deploy/compose/docker-compose.production.yml --profile migrate run --rm migrate
docker compose -f deploy/compose/docker-compose.production.yml up -d app
```

Do not use the migration service as a permanently running sidecar. It exists only to execute `prisma migrate deploy` at the controlled release boundary.

### TLS and reverse proxy

The application defaults to `127.0.0.1:3000`. Put your HTTPS reverse proxy on the public interface and forward only trusted traffic to that loopback binding.

`RATE_LIMIT_TRUST_PROXY_HOPS` remains `0` by default. Change it only when you have verified the exact trusted proxy topology and that the edge overwrites untrusted forwarding headers.

### Storage

The local-storage example persists:

- PostgreSQL through `opengmao_postgres`;
- controlled document files through `opengmao_documents` mounted at `/app/data`.

Coordinate database and document backups as described in `docs/BACKUP.md`. If you use `STORAGE_PROVIDER=s3`, supply the S3 runtime variables through your secret platform and adapt/remove the document volume only after validating your backup/restore procedure.

## Kubernetes example

Files:

- `deploy/kubernetes/app.yaml`
- `deploy/kubernetes/migrate-job.yaml`

The application manifest uses:

- a `ClusterIP` service rather than a public `LoadBalancer`;
- non-root UID/GID `1001`;
- `RuntimeDefault` seccomp;
- `allowPrivilegeEscalation: false`;
- all Linux capabilities dropped;
- service-account token automount disabled;
- resource requests/limits;
- startup/liveness on `/api/health`;
- readiness on `/api/ready`;
- a PVC mounted at `/app/data` for the local storage provider;
- `secretKeyRef` for `DATABASE_URL` rather than inline credentials.

The manifest intentionally omits an Ingress because TLS, certificates, WAF/network policy and trusted-proxy topology are platform-specific. Add an ingress only after applying the controls in `docs/PRODUCTION_HARDENING.md`.

### Secrets

Create the `opengmao-runtime` Secret through your secret-management pipeline. Do not edit a real `DATABASE_URL` into the manifest. GitOps users should prefer an encrypted/external-secret mechanism supported by their cluster rather than committing plaintext Secret objects.

### Images

Both Kubernetes manifests contain an all-zero digest placeholder which cannot accidentally identify a real release. Replace it with the registry digest of the exact reviewed application/migration image before applying the manifest.

The migration image is a separate tooling artifact built from Docker target `builder` for the same commit/release as the runtime image. It contains Prisma tooling; the hardened runtime image intentionally does not.

### Release sequence

1. Back up the active environment.
2. Publish application and migration images from the reviewed release and record their digests.
3. Replace both digest placeholders.
4. Ensure the runtime Secret already exists.
5. Apply/run the migration Job and require success.
6. Apply the application Deployment/PVC/Service.
7. Require readiness before routing user traffic.
8. Verify `/api/health`, `/api/ready`, `/api/metrics`, authentication and critical workflows.

Never make the application Deployment itself run Prisma migrations in an init container for every rollout: migrations belong to the controlled release job so retries and multiple replicas cannot race schema changes.

## Scaling beyond one replica

The Kubernetes example deliberately uses one replica and a `ReadWriteOnce` document PVC. For horizontal scaling, move controlled documents to a shared object-storage provider (for example S3-compatible storage), verify the storage/backup policy, and use distributed/edge rate limiting when consistent cross-replica quotas are required. PostgreSQL must also be provided as a production-capable private service rather than scaled by copying the application Pod pattern.

## What the examples do not provision

They intentionally do not create:

- real credentials or encryption keys;
- public DNS/certificates;
- cloud IAM roles;
- production PostgreSQL HA/replication;
- S3 buckets or retention policies;
- external secret operators;
- ingress/WAF/network policies;
- monitoring/alerting backends;
- backup destinations.

Those are operator-owned controls. Keep the examples public-safe and validate them against your environment's threat model and recovery requirements.