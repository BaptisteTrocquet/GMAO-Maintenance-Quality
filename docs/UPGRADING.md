# Production upgrade and migration procedure

This runbook defines how to upgrade a self-hosted GMAO Maintenance Quality deployment without treating application rollout, PostgreSQL schema changes, controlled-document storage, and rollback as one opaque operation.

The core rule is:

> **Committed Prisma migrations move production databases forward. Rollback is an application/recovery decision, not an automatic SQL down-migration.**

Do not use `prisma db push`, `prisma migrate reset`, ad-hoc schema edits, or startup-time migrations in production.

## Supported migration commands

Schema changes are developed as committed Prisma migrations under `prisma/migrations/` and deployed with:

```bash
npm run prisma:generate
npm run prisma:deploy
npm run prisma:status
```

`prisma:deploy` maps to `prisma migrate deploy` and applies only committed migrations. `db:bootstrap` uses the same migration path for a clean environment.

The production Docker image does **not** run migrations when the application starts. Schema rollout is an explicit deployment step so multiple replicas cannot race each other or silently mutate the database during restart.

Before opening or merging a migration change, run:

```bash
npm run upgrade:check
```

That check rejects normal project scripts that use `prisma db push` or `prisma migrate reset`, verifies that the runtime container does not execute schema changes on startup, and flags common destructive SQL in non-initial migrations unless the migration contains the explicit reviewed marker described below.

## Release pinning and supported upgrade baseline

The formal release/versioning contract is documented in [`RELEASING.md`](RELEASING.md) and machine-readable in [`../release/release-policy.json`](../release/release-policy.json).

Production operators must deploy an immutable version tag or container-image digest associated with the reviewed release commit. Do not deploy a moving branch or mutable `latest` tag and then assume it identifies the schema/application version that was installed.

The release policy pins the **previous supported release** to a full immutable commit SHA. CI checks a direct N-1 upgrade from that baseline to the current source line on the same PostgreSQL database. Older installations should follow the supported release chain unless a release note explicitly documents a wider tested upgrade range.

Run the repository release gate with:

```bash
npm run release:check
```

## Pre-upgrade checklist

Before changing production:

1. Read the target commit/release notes and inspect every new migration since the currently deployed revision.
2. Compare runtime environment variables with `.env.example`; provision new secrets/configuration before rollout.
3. Confirm PostgreSQL and object-storage compatibility with the target deployment.
4. Run the complete CI-equivalent checks against the target code.
5. Create and verify a production backup using `npm run backup:production` and the procedure in `docs/BACKUP.md`.
6. Confirm a recent restore drill exists and that the operator knows the isolated restore-and-switch procedure in `docs/RESTORE.md`.
7. Decide whether the migration is backward-compatible with the currently deployed application.
8. Define the exact application rollback decision before applying the migration.

Do not start a migration when the backup/recovery path is unknown.

## Expand/contract migration strategy

Schema evolution should normally be split across releases.

### Phase 1 — expand

Add structures that both old and new application versions can tolerate, for example:

- nullable columns;
- new tables;
- new indexes, with production-safe creation strategy appropriate to the table size;
- new enum/domain values only when the old application safely ignores or accepts them;
- parallel fields used during a transition.

Apply the expansion migration before or with the new application release, then verify `npm run prisma:status` and `/api/ready`.

### Phase 2 — migrate/backfill

If existing rows need transformation, use a separately reviewable, retry-safe backfill. A data backfill must have an explicit restart/idempotence strategy and must not rely on a browser request staying alive.

For large tables, process data in bounded batches and monitor database load. Do not hide an unbounded data rewrite inside application startup.

### Phase 3 — contract

Only after all supported application versions have stopped reading/writing the old shape should a later release remove obsolete columns, tables, constraints, or types.

Contract migrations are intentionally delayed so an application rollback remains possible during the compatibility window.

## Destructive migration review

`npm run upgrade:check` flags common destructive statements such as `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DROP TYPE`, and column type rewrites in migrations after the initial schema.

The preferred response is to redesign the change as expand/contract. If a destructive step is genuinely required, its `migration.sql` may contain:

```sql
-- gmao: destructive-migration-reviewed
```

That marker is **not** an automatic safety waiver. The pull request must document:

- why expand/contract is insufficient;
- which data can be lost or rewritten;
- the minimum compatible application version;
- backup and restore prerequisites;
- expected locking/runtime impact;
- rollback/forward-fix decision;
- how the migration was exercised on production-shaped synthetic data.

Never add the marker merely to make CI green.

## Standard upgrade sequence

A normal single-environment upgrade is:

```text
1. verify target artifact/commit
2. verify configuration changes
3. quiesce writers if the migration or storage change requires it
4. create + verify a complete DB/storage backup
5. apply committed migrations once
6. verify Prisma migration status
7. deploy new application replica(s)
8. verify /api/health and /api/ready
9. run representative application/document checks
10. enable traffic
11. monitor logs and metrics
```

Example migration commands:

```bash
export DATABASE_URL='postgresql://...'
npm ci --omit=dev=false
npm run prisma:generate
npm run upgrade:check
npm run release:check
npm run prisma:deploy
npm run prisma:status
```

Use deployment automation or a dedicated migration job in real production. Do not run the same migration command concurrently from every application replica.

## Rolling deployment compatibility

A rolling deployment temporarily runs old and new application versions against the same database. Therefore **every schema migration used in a rolling rollout must be backward-compatible with the old application until old replicas are gone**.

If that cannot be guaranteed, use a maintenance window or a staged expand/backfill/contract sequence rather than a mixed-version rollout.

Readiness only proves required dependencies are reachable. It does not prove old application code is compatible with a new destructive schema.

## Rollback decision matrix

### Application failed before migrations

No database change occurred. Roll the application artifact back to the previously pinned version and investigate.

### Backward-compatible migration succeeded, new app failed

If the previous application version is explicitly compatible with the expanded schema, roll the application back while leaving the forward migration in place. Fix the application and redeploy forward later.

Do **not** generate an ad-hoc SQL down migration just to make the schema look older.

### Migration succeeded but old application is not compatible

Do not send traffic to the old application against the incompatible schema. Choose one of:

1. deploy a forward fix that restores a working compatible application; or
2. recover the pre-upgrade database **and matching controlled-document/object-storage state** from the verified backup into isolated resources, validate it, then switch traffic using `docs/RESTORE.md`.

A database-only rollback can be invalid if document metadata and object storage changed after the backup point.

### Migration failed

`prisma migrate deploy` stops on failure and Prisma records migration state. Do not repeatedly edit the already-applied migration directory or use `migrate reset` in production.

Stop traffic/writers as needed, inspect Prisma migration state and database state, then either:

- correct the forward migration using Prisma's documented production recovery workflow and a new reviewed migration; or
- restore to an isolated verified pre-upgrade recovery point.

Never mark a failed migration as applied merely to bypass the error without verifying that the intended schema actually exists.

## Forward-fix policy

Once a committed migration has been successfully applied to production, treat it as immutable history. Fix mistakes with a **new** committed migration.

Do not rewrite an applied migration file on `main`: environments that already recorded the original migration would then disagree with fresh installations and with each other.

## Controlled-document storage changes

Database and controlled-document storage are one logical recovery state. If an upgrade changes object keys, storage provider, checksums, or file layout:

- make the storage transformation restart-safe;
- preserve old objects until the rollback window closes;
- verify representative controlled copies before enabling traffic;
- include both DB and storage behavior in the rollback plan.

See `docs/BACKUP.md` and `docs/RESTORE.md` for the consistency boundary.

## Post-upgrade validation

At minimum:

```bash
npm run prisma:status
npm run test:db
```

Then verify operational endpoints:

```text
GET /api/health -> 200
GET /api/ready  -> 200
GET /api/metrics -> scrape succeeds
```

Also verify representative tenant-scoped workflows and at least one controlled-document read/checksum path when the release touches those domains.

Monitor structured logs and application metrics for elevated failures before declaring the upgrade complete.

## Automated previous-release upgrade drill

`.github/workflows/upgrade-drill.yml` exercises the supported release boundary on disposable PostgreSQL for relevant pull requests and `main` changes.

The workflow:

1. reads the full SHA and version from `release/release-policy.json`;
2. checks out that immutable previous supported release separately from the candidate source;
3. verifies the baseline commit's `package.json` version matches the policy;
4. installs the previous release with its own lockfile;
5. applies its committed migrations and deterministic synthetic seed;
6. captures IDs and stable fields for representative synthetic organization, site, asset, work order and part records;
7. installs the current candidate and applies only its committed migrations to the **same database**;
8. compares the historical records byte-for-byte before and after the upgrade;
9. verifies Prisma migration status and runs the candidate database smoke check.

The drill deliberately does not reseed before the comparison: the check is intended to prove migration compatibility and historical preservation, not to allow the current seed to repair or replace old state.

A green drill proves the repository's declared N-1 path was exercised in CI. It does not replace production backup, restore or environment-specific compatibility checks.
