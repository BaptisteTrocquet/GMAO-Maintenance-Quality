# Production upgrade and migration procedure

This runbook defines how to upgrade GMAO Maintenance Quality without treating an application deploy and a PostgreSQL schema change as the same operation.

The project uses **committed Prisma migrations**. Production applies them with `npm run prisma:deploy`; production must not use `prisma migrate dev`, `prisma db push`, `prisma migrate reset`, or `db:bootstrap` as an upgrade mechanism.

`db:bootstrap` is a clean-clone/development helper and also seeds synthetic demo data. It is not a production deployment command.

## Core rules

1. Build an immutable application artifact/image before changing production data.
2. Take a verified pre-upgrade backup of PostgreSQL and the matching controlled-document storage recovery point.
3. Run schema migration as **one explicit deployment job**, never independently in every application replica.
4. Apply only migration files committed in `prisma/migrations/`.
5. Never edit, delete, reorder, or replace a migration that has already been applied to a supported environment.
6. Prefer backward-compatible **expand → deploy/backfill → contract later** changes when zero/low-downtime rollout matters.
7. Roll back the application only when the migrated schema is known to remain compatible with the previous application.
8. When schema/data compatibility is uncertain or broken, restore the verified pre-upgrade backup into an isolated target and switch traffic only after validation.
9. A failed or incorrect applied migration is normally fixed **forward with a new migration**. Do not invent an ad-hoc down migration in production.
10. Never print database URLs, credentials, storage secrets, connector keys, tokens, or backup secrets in upgrade logs.

## Before the maintenance window

Identify the exact immutable `from` and `to` application refs/images. Until the E14 release/versioning story defines the formal supported-release window, operators must record the exact source and target commit/tag/image digest in the change record rather than assuming `latest` is a version.

Review the migration delta before deployment:

```bash
git diff <from-ref>..<to-ref> -- prisma/schema.prisma prisma/migrations/
```

Classify the database change:

- **No schema change:** normal application rollout; no migration job is needed beyond confirming status.
- **Backward-compatible expand:** additive tables/columns/indexes/constraints that the previous application can tolerate. Prefer this for rolling deployments.
- **Data migration/backfill:** plan bounded execution, monitoring, idempotence/restart behavior, and write coordination explicitly.
- **Contract/destructive change:** dropping/renaming fields, tightening constraints before data is ready, or changing semantics in a way the previous application cannot tolerate. Use a maintenance/cutover plan or split the work across releases.

Before any production schema write:

```bash
npm run backup:production
```

Follow `docs/BACKUP.md` and ensure the database dump and controlled-document/object-storage recovery point represent the same logical recovery point. A backup that has never been restorable is not an upgrade rollback plan; follow `docs/RESTORE.md` and the documented restore drill.

Also verify:

- production secrets/configuration required by the target application are provisioned;
- the target image was built and passed CI;
- capacity and storage are sufficient for migrations/backfills;
- the current deployment is healthy before the change;
- the exact rollback decision and traffic-switch mechanism are known before starting.

## Expand/contract strategy

For changes that must support overlapping old/new application replicas, prefer multiple releases instead of one destructive migration.

### Release A — expand

Add new schema structures without removing the old contract. Typical examples are nullable columns, new tables, new indexes, or a second representation that old code simply ignores.

The old application must continue to function against this expanded schema.

### Release B — use/backfill

Deploy code that can use the new representation. If data needs to be copied/transformed, make the backfill separately observable and safe to retry where practical. Do not hide a large unbounded backfill inside normal application startup.

When both old and new representations coexist, define which one is authoritative and how writes remain consistent during the transition.

### Later release — contract

Only remove the old schema after the previous application version can no longer be rolled back to it and the new data path has been verified. Contract migrations must not be bundled into the same rolling window that still depends on backward compatibility.

## Production upgrade sequence

### 1. Hold the rollout

Do not start new application replicas that require a schema which has not been applied yet. If the migration is not backward compatible with existing writers, enter the documented maintenance/cutover mode and stop or drain writes first.

### 2. Run committed migrations exactly once

From the target release artifact/source with production credentials supplied at runtime:

```bash
npm run prisma:deploy
npm run prisma:status
```

`prisma:deploy` maps to `prisma migrate deploy`. It applies pending committed migrations; it does not create development migrations.

Do not run `prisma migrate dev`, `prisma db push`, `prisma migrate reset`, or `db:bootstrap` in production.

### 3. Verify the migrated database before broad traffic

At minimum:

```bash
npm run prisma:status
npm run test:db
```

Then start a target application instance/canary and verify:

- `/api/health` returns healthy;
- `/api/ready` returns ready against the migrated database;
- application logs contain no unexpected migration/database failures;
- representative tenant-scoped reads work;
- representative controlled-document reads/checksum validation work when documents are part of the changed path;
- metrics show normal readiness/error behavior.

Do not expose the full new fleet until readiness is stable.

### 4. Roll out the application

Roll out the immutable target image/ref. For rolling deployment, the previous and target application versions must both be compatible with the currently deployed schema for the overlap period.

### 5. Observe before declaring success

Monitor readiness, error rates, database errors/latency, worker failures, and the domain paths affected by the release. Keep the pre-upgrade backup and previous application artifact available until the change is accepted.

## Rollback and forward-fix decision

There is deliberately no generic `npm run migrate:down` command.

### Application-only rollback

Rolling the application back to the previous immutable artifact is acceptable **only if the new schema is backward compatible with that application**.

Examples include a purely additive migration where the old code ignores the new structures. After application rollback, do not delete the newly added schema just to make the database look old; leave it in place and fix forward unless an approved recovery plan says otherwise.

### Fix forward

If a migration is applied and the database remains trustworthy, create a **new committed Prisma migration** that corrects the problem. Never rewrite an already-applied migration file to make history look different.

The correction must pass the same migration, DB, test, and build gates as any other schema change.

### Restore-and-switch rollback

If the target schema is incompatible with the previous application, a destructive/data migration produced unacceptable results, or database state cannot be trusted, use the pre-upgrade recovery point:

1. stop/isolate writers;
2. restore PostgreSQL and the matching storage recovery point into new isolated resources using `docs/RESTORE.md`;
3. verify checksums, migration state, DB smoke checks, health and readiness;
4. start the previous compatible application artifact against those recovered resources without public traffic;
5. validate representative application paths;
6. switch traffic/configuration to the recovered environment;
7. retain the failed environment for incident analysis until recovery is accepted.

Do not run an improvised reverse SQL script against the live failed database as the default rollback path.

## Failed Prisma migration handling

If `prisma migrate deploy` fails:

- stop the rollout;
- do not start application versions that depend on the failed migration;
- capture the migration name and sanitized error context without logging secrets;
- inspect database state and Prisma migration history before taking another schema action;
- determine whether the database is safely usable at the previous contract, requires a forward corrective migration, or should be restored to the pre-upgrade recovery point.

Do not use `prisma migrate reset` in production.

`prisma migrate resolve` is **not** a normal retry/rollback tool. Use it only during an explicitly reviewed recovery when operators have verified the real database state and the intended migration-history state. Record why it was required and the exact migration marked applied/rolled back. A resolve command changes Prisma's migration history interpretation; it does not magically undo arbitrary SQL or restore business data.

## Storage and schema coordination

Controlled-document metadata lives in PostgreSQL while file bytes may live in local persistent storage or S3-compatible object storage. If an upgrade changes storage behavior or stored-object format, the database backup and storage recovery point must remain coordinated.

Never restore only one side and assume metadata/object bytes will still match. The controlled-document checksum is part of the integrity model.

## Multi-replica deployments

Application containers do not run migrations at startup by design. For Kubernetes, Compose, Nomad, VM/systemd, or another orchestrator, use a separate one-shot migration job/task before enabling target replicas that require the new schema.

Only one deployment actor should own the production migration step. Multiple web replicas racing `prisma migrate deploy` are not the deployment model even when Prisma can serialize some migration operations.

## CI coverage and remaining release gate

Current CI already verifies that:

- every committed migration applies to a clean PostgreSQL database;
- `prisma migrate status` reports an up-to-date schema;
- the seeded database passes the DB integration smoke check;
- production backup/restore is exercised against disposable recovery resources;
- the production application image builds and its runtime contract is checked.

This runbook establishes the E14 **migration rollback/forward strategy**.

It does **not** by itself satisfy the separate mandatory check **Upgrade from previous supported release tested**. That check requires the release/versioning policy to define a previous supported release and CI/release validation to actually upgrade a database created by that release to the target release.

## Production change record

For each upgrade, retain at least:

- source application ref/tag/image digest;
- target application ref/tag/image digest;
- migration names in the change;
- backup/recovery-point identifier and verification result;
- start/end times;
- migration result and `prisma:status` result;
- health/readiness validation result;
- any backfill/cutover action;
- rollback or fix-forward decision;
- incident/reference identifier if recovery tooling such as `prisma migrate resolve` was required.

Do not put credentials, tokens, private keys, database URLs containing passwords, or sensitive business payloads into that record.