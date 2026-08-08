# Production deployment examples

This guide provides two reference deployments for self-hosting GMAO Maintenance Quality:

- `deploy/compose/docker-compose.production.yml` for a single-host Docker Compose installation;
- `deploy/kubernetes/app.yaml` plus `deploy/kubernetes/migrate-job.yaml` for Kubernetes.

They are examples, not a replacement for the target platform's security review. They deliberately contain no production credentials or private organization/equipment data.

Read these runbooks before rollout:

- [`PRODUCTION_DOCKER.md`](PRODUCTION_DOCKER.md)
- [`PRODUCTION_HARDENING.md`](PRODUCTION_HARDENING.md)
- [`HEALTH_READINESS.md`](HEALTH_READINESS.md)
- [`BACKUP.md`](BACKUP.md)
- [`RESTORE.md`](RESTORE.md)
- [`UPGRADING.md`](UPGRADING.md)
- [`RATE_LIMITING.md`](RATE_LIMITING.md)
- [`STRUCTURED_LOGGING.md`](STRUCTURED_LOGGING.md)
- [`APPLICATION_METRICS.md`](APPLICATION_METRICS.md)

## Shared release boundary

Application and migration images must come from the **same reviewed release source**. The final application runtime intentionally contains only the standalone Node server; npm and Prisma CLI are removed from it. Migration tooling therefore uses the dedicated short-lived Docker target `migration`, which contains the committed Prisma migrations and CLI but still runs as UID `1001` and removes global package managers.

```sh
docker build --target runner -t registry.example.invalid/opengmao:<release> .
docker build --target migration -t registry.example.invalid/opengmao-migrations:<release> .
```

Push those images through the production registry workflow, record their immutable digests, and deploy immutable release tags or digests rather than floating tags such as `latest`.

Secrets are injected at runtime. Do not commit production `.env` files, Kubernetes Secret objects, database URLs, API keys, connector-vault keys, OIDC credentials, object-storage credentials, webhook secrets, real employee information, real asset identifiers, or internal documents.

Prisma migrations are an explicit release step. Never make every application replica run migrations at startup, and never replace committed migrations with `prisma db push` or `prisma migrate reset`.

# Docker Compose

The Compose example keeps PostgreSQL private, binds the application to loopback by default, persists PostgreSQL and controlled documents separately, drops capabilities, and applies `no-new-privileges`.

## Runtime configuration

The example has no mutable image fallback. Supply these values outside source control before running it:

```text
OPENGMAO_IMAGE=registry.example.invalid/opengmao@sha256:<digest>
OPENGMAO_MIGRATION_IMAGE=registry.example.invalid/opengmao-migrations@sha256:<digest>
POSTGRES_IMAGE=registry.example.invalid/postgres@sha256:<reviewed-digest>
POSTGRES_PASSWORD=<runtime secret>
DATABASE_URL=<runtime secret using host db>
```

Use the platform's secret manager where possible. If a host environment file is required, keep it outside the repository with restrictive permissions.

## Release sequence

1. Take and verify the coordinated backup described in `BACKUP.md`.
2. Run `npm run upgrade:check` against the reviewed source revision.
3. Start or verify PostgreSQL.
4. Run the one-shot migration profile and require success.
5. Start/update the application image.
6. Verify health, readiness, metrics, authentication and critical workflows.

```sh
docker compose --env-file /etc/opengmao/runtime.env \
  -f deploy/compose/docker-compose.production.yml up -d db

docker compose --env-file /etc/opengmao/runtime.env \
  -f deploy/compose/docker-compose.production.yml \
  --profile migrate run --rm migrate

docker compose --env-file /etc/opengmao/runtime.env \
  -f deploy/compose/docker-compose.production.yml up -d app
```

The migration service is a release tool, not a sidecar. It executes `prisma migrate deploy` once and exits. Its image should be built from the same source revision as the application image using Docker target `migration`.

## TLS, proxies and rate limiting

The application defaults to `127.0.0.1:3000`. Put a controlled HTTPS reverse proxy or load balancer in front of it. `RATE_LIMIT_TRUST_PROXY_HOPS` remains `0` by default; change it only after verifying the exact trusted proxy topology and ensuring the edge overwrites untrusted forwarding headers.

PostgreSQL has no host `ports` mapping in the example.

## Storage and recovery

Local controlled documents are persisted in `opengmao_documents` mounted at `/app/data`; PostgreSQL uses `opengmao_postgres`. Treat both as one recovery boundary and follow `BACKUP.md` / `RESTORE.md`.

For multi-host or multi-replica deployments, move controlled documents to the supported S3-compatible provider or another validated shared-storage design. Process-local rate limiting also needs an ingress/distributed layer when quotas must be consistent across replicas.

## Verification

```sh
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/ready
curl --fail http://127.0.0.1:3000/api/metrics
```

`/api/health` is liveness; `/api/ready` verifies PostgreSQL. Restrict `/api/metrics` to the monitoring plane when the reverse proxy exposes the application publicly.

# Kubernetes

The Kubernetes application example intentionally provides only a `ClusterIP` Service. It omits Ingress because TLS termination, certificates, WAF/network policy, monitoring-path restrictions and trusted-proxy topology are platform-specific.

The local-storage example uses one replica, a `ReadWriteOnce` PVC at `/app/data`, `Recreate` rollout strategy, non-root UID/GID `1001`, `RuntimeDefault` seccomp, no service-account token, `allowPrivilegeEscalation: false`, all capabilities dropped, and resource requests/limits.

Startup/liveness probe `/api/health`; readiness probes `/api/ready`.

## Images

Both committed Kubernetes manifests use an all-zero SHA-256 digest placeholder. It cannot identify a real release. Replace each placeholder with the exact reviewed registry digest before applying the manifest.

The migration image must be built from Docker target `migration` for the same source revision as the application `runner` image. Do not reuse the stripped runtime image for migration tooling and do not use the root-owned `builder` stage as the production migration image.

## Runtime secret

Create `opengmao-runtime` through your secret-management pipeline. The manifests use `secretKeyRef` and do not contain a plaintext `DATABASE_URL`.

For a simple bootstrap from an operator-controlled file outside the repository:

```sh
kubectl create secret generic opengmao-runtime \
  --from-env-file=/secure/opengmao-runtime.env \
  --dry-run=client -o yaml | kubectl apply -f -
```

Do not commit the generated Secret YAML.

## Release sequence

1. Back up the active environment.
2. Publish application + migration images for one reviewed release and record their digests.
3. Replace both digest placeholders.
4. Ensure `opengmao-runtime` already exists.
5. Run the migration Job and require completion.
6. Apply the application Deployment/PVC/Service.
7. Require readiness before promoting ingress traffic.
8. Verify operational endpoints and critical workflows.

```sh
kubectl delete job opengmao-migrate --ignore-not-found
kubectl apply -f deploy/kubernetes/migrate-job.yaml
kubectl wait --for=condition=complete job/opengmao-migrate --timeout=5m
kubectl apply -f deploy/kubernetes/app.yaml
kubectl rollout status deployment/opengmao --timeout=5m
```

A temporary port-forward can verify the new Deployment without a public Service:

```sh
kubectl port-forward service/opengmao 3000:80
```

Never put `prisma migrate deploy` into every application Pod's startup/init path. The separate Job is the controlled release boundary.

## Scaling boundary

The committed example is deliberately single-replica because its PVC is `ReadWriteOnce`. Before horizontal scaling, use a validated shared document backend (for example S3-compatible storage), review storage access modes and deployment strategy, and add distributed/ingress rate limiting when required.

# Operator-owned controls

The examples intentionally do not provision real secrets, public DNS/certificates, cloud IAM, production PostgreSQL HA/replication, S3 retention, external-secret operators, ingress/WAF/network policies, alerting backends, or backup destinations. Apply the controls in `PRODUCTION_HARDENING.md` and validate the deployment against your environment's threat model and recovery requirements.
