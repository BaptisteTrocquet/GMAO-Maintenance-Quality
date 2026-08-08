# Production upgrades and database migrations

OpenGMAO treats application code, PostgreSQL schema, and controlled-document storage as one production system. Production upgrades must therefore be planned, backed up, migrated deliberately, verified, and recoverable.

This document defines the supported migration direction and rollback model for self-hosted deployments.

## Core rules

1. Production schema changes use committed Prisma migrations only.
2. `prisma db push` is not a production deployment mechanism.
3. `prisma migrate reset` is never a production recovery mechanism.
4. The application container does not run migrations automatically at startup.
5. Run migrations as one explicit deployment step before new replicas receive traffic.
6. Do not create hand-written down migrations as an automatic rollback path.
7. Potentially destructive or backwards-incompatible migration SQL requires an explicit repository safety review.
8. Back up PostgreSQL and controlled-document storage before an upgrade that changes persistent state.

The repository enforces several of these rules through `npm run migration:check` and the migration-safety CI workflow.

## Standard production upgrade

### 1. Read the target release material

Before touching production, review:

- release notes and known breaking changes;
- committed migrations between the current and target versions;
- new or removed environment variables;
- storage-provider changes;
- any migration-specific `SAFETY.md` files.

Do not upgrade directly from an unlisted/unsupported version once the release policy defines supported upgrade ranges.

### 2. Verify the current deployment

Confirm before the maintenance window:

- `/api/health` returns `200`;
- `/api/ready` returns `200`;
- `npm run prisma:status` reports the current schema state expected for the running version;
- document storage is reachable and durable;
- the current image/tag or commit is recorded so an application rollback is possible.

### 3. Create a recoverable backup

Use the production backup procedure in `docs/BACKUP.md`.

For local document storage, quiesce writers as required by that procedure so the database and files belong to one recovery point. For S3/S3-compatible storage, secure the provider-native recovery point required by the backup procedure.

Do not continue if the backup cannot be validated.

### 4. Stop or drain writes when required

Whether a full maintenance window is required depends on the migration. Prefer backwards-compatible expand/contract migrations so old and new application replicas can overlap safely.

For migrations that require exclusive access, large rewrites, or non-compatible schema changes, drain application traffic and stop writers before applying the migration.

### 5. Run the migration once

Use a dedicated release/deployment job with the target application source or image tooling:

```bash
npm ci --omit=dev=false
npm run migration:check
npm run prisma:generate
npm run prisma:status
npm run prisma:deploy
npm run prisma:status
```

`prisma migrate deploy` is intentionally the production command. Do not run `prisma migrate dev`, `prisma db push`, or `prisma migrate reset` against production.

In a multi-replica deployment, exactly one migration job should perform this step. Application replicas must not race each other to mutate the schema during startup.

### 6. Deploy the target application

Start the new application version only after the schema step succeeds. Keep new replicas out of service until `/api/ready` reports ready.

Recommended rollout sequence:

1. apply committed migrations once;
2. start one target-version replica;
3. verify `/api/health`, `/api/ready`, and `/api/metrics`;
4. perform a bounded functional smoke test;
5. continue the rollout;
6. keep the prior application image available until the verification window is complete.

### 7. Verify after rollout

At minimum verify:

- `npm run prisma:status` shows no pending or failed migration;
- `/api/health` returns `200`;
- `/api/ready` returns `200`;
- application error rate/logs do not show a migration/runtime incompatibility;
- a known safe read workflow succeeds;
- a controlled-document read still resolves the expected storage object;
- business writes are re-enabled only after readiness and smoke checks succeed.

## Forward migration strategy

Production database evolution is **forward-first**.

Prefer expand/contract changes across releases:

1. **Expand:** add nullable columns/tables/indexes or other structures that both old and new code can tolerate.
2. **Migrate/backfill:** populate new structures in bounded operational steps when needed.
3. **Switch:** deploy code that uses the new representation while remaining compatible with the expanded schema.
4. **Contract later:** remove old structures only in a later release after all supported old application versions no longer need them.

A failed migration should normally be corrected with a new forward migration rather than editing a migration that has already reached production.

Never rewrite or delete an already-published migration directory to make history appear successful.

## Rollback strategy

Rollback depends on how far the upgrade progressed.

### Application failed before schema migration

No persistent change occurred. Fix or roll back the application/release job and retry after validation.

### Migration succeeded and remains backwards-compatible

If the prior application version is explicitly compatible with the migrated schema, rolling the **application image** back can be acceptable while leaving the schema forward-migrated.

Do not assume compatibility. It must be established by the migration/release design.

### Migration succeeded but is not backwards-compatible

Do **not** attempt an improvised SQL down migration in production.

Choose one of these controlled recovery paths:

- ship a new forward-fix migration/application build; or
- restore the pre-upgrade recovery point into an isolated PostgreSQL/database-storage target using `docs/RESTORE.md`, verify it, and switch traffic to the recovered deployment.

The restore procedure intentionally follows restore-and-switch semantics rather than overwriting the active database in place.

### Why there are no automatic down migrations

Many schema/data changes are not safely reversible after new-version writes begin. A syntactically valid `DROP`/rename reversal can still lose data or reinterpret history incorrectly.

For that reason OpenGMAO uses:

- validated backups;
- forward-compatible migrations where possible;
- explicit forward-fix migrations;
- isolated restore-and-switch recovery for incompatible failures.

## Destructive/backwards-incompatible migration review

`npm run migration:check` scans non-baseline migration SQL for operations such as:

- `DROP TABLE`;
- `DROP COLUMN`;
- `TRUNCATE`;
- `DROP TYPE`;
- `DROP CONSTRAINT`;
- `RENAME COLUMN`;
- `ALTER COLUMN ... TYPE`.

If such SQL is required, add `SAFETY.md` next to that migration's `migration.sql` and include the exact marker:

```text
Migration safety review: APPROVED
```

The review should document at least:

- why the incompatible/destructive operation is required;
- which application versions remain compatible before and after it;
- expected locks and downtime;
- data-preservation/backfill steps;
- backup/recovery point required before execution;
- forward-fix plan if deployment fails after the migration;
- conditions under which restore-and-switch would be used.

The marker is a repository gate, not a substitute for an actual review.

## CI migration drill

`.github/workflows/migration-safety.yml` creates an isolated PostgreSQL database and performs a forward migration drill:

1. apply only the earliest committed baseline migration;
2. insert a synthetic sentinel organization into that baseline schema;
3. expose the remaining committed migration directories;
4. run `prisma migrate deploy` again;
5. verify the sentinel record survived;
6. verify a table introduced by a later migration exists;
7. verify Prisma reports the drill database fully up to date.

This proves that the repository's committed migration chain can move a baseline database forward without resetting it.

It does **not** by itself satisfy the Epic check "Upgrade from previous supported release tested". That check must remain open until the release/versioning process defines a previous supported release and CI/tests exercise that exact release-to-release path.

## Emergency migration rules

If a production migration fails:

- stop the rollout;
- preserve logs and the exact migration name/error code without exposing credentials;
- do not mark a failed migration as applied merely to unblock deploy;
- do not edit production data blindly to match Prisma history;
- determine whether Prisma's documented `migrate resolve` flow is appropriate only after the database's actual partial state is understood;
- prefer a reviewed corrective migration or restore-and-switch recovery;
- record the incident and resulting operational decision.

## Environment and secret handling

Database URLs and storage credentials are runtime secrets. Do not place them in:

- migration SQL;
- migration `SAFETY.md` files;
- committed `.env` files;
- CI output;
- release notes.

Use the deployment platform's secret mechanism and keep operational endpoints on the intended monitoring/network boundary.

## Current release-boundary note

The repository currently has not yet completed the E14 release/versioning story. Until that story defines supported release boundaries, `main`/arbitrary commits should not be described as a formally supported previous release.

The migration chain and baseline-forward drill are real safety controls, but the Epic mandatory check for upgrading from the previous supported release remains intentionally open.