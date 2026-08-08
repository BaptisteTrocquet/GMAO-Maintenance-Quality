# Production deployment examples

This guide provides two reference deployments for self-hosting GMAO Maintenance Quality:

- a single-host Docker Compose example for small installations;
- a Kubernetes example for orchestrated environments.

They are examples, not a replacement for the target platform's security review. Read [`PRODUCTION_HARDENING.md`](PRODUCTION_HARDENING.md), [`UPGRADING.md`](UPGRADING.md), [`BACKUP.md`](BACKUP.md), [`RESTORE.md`](RESTORE.md), [`HEALTH_READINESS.md`](HEALTH_READINESS.md), [`APPLICATION_METRICS.md`](APPLICATION_METRICS.md), and [`RATE_LIMITING.md`](RATE_LIMITING.md) before production rollout.

## Release artifacts

The Dockerfile intentionally separates the long-running application runtime from build/release tooling.

Build the application image from the hardened `runner` target:

```sh
docker build --target runner -t registry.example/opengmao/app:RELEASE .
```

A migration job needs Prisma CLI tooling, which is intentionally absent from the final application runtime. Build a separate, short-lived migration image from the `builder` target:

```sh
docker build --target builder -t registry.example/opengmao/migrations:RELEASE .
```

The migration image is release tooling. Do not run it as the public application service and do not expose it to inbound traffic. Production registries should use immutable release tags or digests rather than `latest`.

## Secrets

Do not commit production `.env` files, Kubernetes `Secret` objects, database URLs, API keys, connector vault keys, OIDC credentials, object-storage credentials, or webhook secrets.

Use the platform's secret manager where possible. If an external environment file is used for the Compose example, store it outside the repository with restrictive filesystem permissions. A minimal file needs at least:

```text
POSTGRES_PASSWORD=<generated database password>
DATABASE_URL=<PostgreSQL URL using host db for the Compose example>
```

Optional runtime variables documented in `.env.example` can be added to the same external secret source.

# Docker Compose

The reference file is [`../deploy/compose/docker-compose.production.yml`](../deploy/compose/docker-compose.production.yml).

It deliberately:

- does not publish the PostgreSQL port;
- binds the application to `127.0.0.1` by default so a controlled HTTPS reverse proxy can front it;
- stores PostgreSQL and local controlled documents on separate durable volumes;
- drops Linux capabilities and enables `no-new-privileges` on the application and migration services;
- keeps database migration as an explicit release step rather than application startup behavior;
- preserves the image liveness healthcheck instead of turning a database outage into an application restart loop.

## 1. Prepare runtime configuration

Create an external file, for example `/etc/opengmao/runtime.env`, owned by the deployment account and not by the repository checkout. Populate `POSTGRES_PASSWORD` and `DATABASE_URL` with production values. The database URL should address the Compose service name `db`, not `localhost`.

## 2. Start PostgreSQL

```sh
docker compose \
  --env-file /etc/opengmao/runtime.env \
  -f deploy/compose/docker-compose.production.yml \
  up -d db
```

## 3. Apply committed migrations

Run the migration profile before starting the new application revision:

```sh
docker compose \
  --env-file /etc/opengmao/runtime.env \
  -f deploy/compose/docker-compose.production.yml \
  --profile migrate \
  run --rm migrate
```

Only committed Prisma migrations are applied. Never substitute `prisma db push` or `prisma migrate reset`.

## 4. Start or replace the application

```sh
docker compose \
  --env-file /etc/opengmao/runtime.env \
  -f deploy/compose/docker-compose.production.yml \
  up -d app
```

The default bind address is loopback. Put an HTTPS reverse proxy or load balancer in front of port 3000. If the proxy forwards client addresses, set `RATE_LIMIT_TRUST_PROXY_HOPS` only after verifying the exact trusted topology and ensuring the proxy overwrites untrusted forwarding headers.

## 5. Verify the deployment

From the host:

```sh
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/ready
curl --fail http://127.0.0.1:3000/api/metrics
```

`/api/health` is liveness. `/api/ready` is the traffic-admission check and requires PostgreSQL. Restrict `/api/metrics` to the monitoring plane when exposing the application through a reverse proxy.

## Compose scaling note

The example uses local controlled-document storage. Treat the `opengmao_documents` volume as part of the recovery state together with PostgreSQL. Do not scale the application across hosts while relying on a node-local volume. Multi-host or multi-replica deployments should use a suitable shared storage design, such as the supported S3-compatible provider, and should add ingress-level distributed rate limiting when a global quota is required.

# Kubernetes

The reference manifests are:

- [`../deploy/kubernetes/app.yaml`](../deploy/kubernetes/app.yaml) for the application, persistent local document storage, and ClusterIP service;
- [`../deploy/kubernetes/migrate-job.yaml`](../deploy/kubernetes/migrate-job.yaml) for the explicit Prisma migration job.

The example intentionally omits an Ingress because TLS termination, certificate management, trusted proxy topology, network policy, and monitoring-path restrictions are platform-specific.

## 1. Publish immutable images

Build and push the application and migration images for one release. Replace the example image references in both manifests with immutable release tags or digests before applying them.

The migration image must correspond to the same source revision as the application image.

## 2. Create runtime secrets outside Git

Create the `opengmao-runtime` secret from an operator-controlled file or external secret manager. For a simple kubectl bootstrap, the file should live outside the repository and contain at least `DATABASE_URL=...`:

```sh
kubectl create secret generic opengmao-runtime \
  --from-env-file=/secure/opengmao-runtime.env \
  --dry-run=client -o yaml | kubectl apply -f -
```

Do not commit the generated YAML output. If S3-compatible storage or other secret-backed integrations are enabled, inject those variables through the platform's secret mechanism as well.

## 3. Run the migration job

The migration job uses the release-tooling image and runs `prisma migrate deploy` as a non-root numeric user with no service-account token, no Linux capabilities, and a read-only root filesystem.

A Kubernetes Job is immutable once created, so remove the completed prior job before applying the next release manifest:

```sh
kubectl delete job opengmao-migrate --ignore-not-found
kubectl apply -f deploy/kubernetes/migrate-job.yaml
kubectl wait --for=condition=complete job/opengmao-migrate --timeout=5m
```

Inspect the job logs and stop the release if migration fails. Follow `UPGRADING.md` for backup, compatibility, rollback, forward-fix, and destructive-migration decisions.

## 4. Apply the application manifest

```sh
kubectl apply -f deploy/kubernetes/app.yaml
kubectl rollout status deployment/opengmao --timeout=5m
```

The example uses:

- one replica;
- `Recreate` deployment strategy;
- a `ReadWriteOnce` PVC mounted at `/app/data`;
- `runAsNonRoot` with UID/GID `1001`;
- dropped Linux capabilities and `allowPrivilegeEscalation: false`;
- startup/liveness probes on `/api/health`;
- readiness on `/api/ready`;
- a ClusterIP service only.

This deliberately matches the default local-storage model. To scale beyond one replica, move controlled-document persistence to an appropriate shared backend, review deployment strategy and storage access modes, and add distributed/ingress rate limiting if global quotas are required.

## 5. Verify before ingress promotion

A temporary port-forward can verify the new replica without exposing it publicly:

```sh
kubectl port-forward service/opengmao 3000:80
```

Then verify:

```sh
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/ready
curl --fail http://127.0.0.1:3000/api/metrics
```

Only after readiness and critical workflows are verified should the release receive production traffic.

## Ingress requirements

When adding a platform-specific Ingress or load balancer:

- terminate TLS and redirect public HTTP to HTTPS;
- do not expose PostgreSQL or storage administration endpoints;
- restrict `/api/metrics` and preferably health/readiness paths to monitoring/internal networks;
- configure the exact trusted proxy hop count only when forwarding-header replacement is controlled;
- enforce distributed rate limiting at ingress when multiple replicas must share one quota;
- keep application authorization, tenant isolation, and idempotency independent of ingress controls.

# Backup and rollback boundary

Deployment does not replace recovery planning. Before a material upgrade, take and verify the coordinated PostgreSQL + controlled-document backup described in `BACKUP.md`. Restore drills use isolated targets as described in `RESTORE.md`.

If a new application fails after a backward-compatible migration, application rollback is permitted only when the previous image is explicitly compatible with the expanded schema. If an incompatible migration has landed, follow the documented forward-fix or isolated restore-and-switch procedure instead of inventing an automatic down migration.
