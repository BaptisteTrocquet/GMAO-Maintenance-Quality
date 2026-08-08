# Production restore procedure

This runbook restores a backup created by `npm run backup:production` into an **empty, isolated recovery target**. The restore tooling deliberately refuses to overwrite an existing application schema.

A recovery is not complete until both PostgreSQL and controlled-document/object storage have been restored to the same logical recovery point and the restored application has been verified before traffic is enabled.

## Safety model

`npm run restore:production` requires:

```bash
export RESTORE_ACKNOWLEDGE_ISOLATED_TARGET=true
```

This acknowledgement is not the safety check by itself. The script also verifies that the target database/schema contains no application tables before `pg_restore` runs.

The script never uses `pg_restore --clean`, never drops existing application objects, and never restores into a non-empty target. Build a new database/schema and a new storage namespace first. Cut traffic over only after the recovery has been validated.

Before any target write, the script:

1. validates the backup manifest format;
2. verifies every SHA-256 listed in `SHA256SUMS`;
3. verifies that `pg_restore` can parse the custom-format database dump;
4. verifies the storage mode and required artifact/acknowledgement;
5. verifies that the target database/schema is empty.

PostgreSQL is restored with `--single-transaction --exit-on-error --no-owner --no-privileges`, so a database restore failure rolls back rather than leaving a partially restored application schema.

## Prerequisites

The restore host needs:

- Bash;
- Node.js 22;
- `psql` and `pg_restore` compatible with the PostgreSQL server version;
- `sha256sum`;
- `tar`, `realpath`, `find`, and standard coreutils for local-storage restores.

Supply credentials at runtime through the deployment secret manager. Do not put database URLs, passwords, object-storage credentials, connector master keys, or other secrets into the repository or restore artifacts.

## Local-storage restore

Create a new empty database first. Do **not** point the restore at the live database.

Example:

```bash
export RESTORE_SOURCE_DIR=/srv/gmao/backups/gmao-20260808T120000Z
export RESTORE_DATABASE_URL='postgresql://restore_user:...@db.example/recovery?schema=public'
export RESTORE_STORAGE_DIR=/srv/gmao/recovery/documents
export RESTORE_ACKNOWLEDGE_ISOLATED_TARGET=true

npm run restore:production
```

`RESTORE_STORAGE_DIR` must not exist before the restore. The script extracts the controlled-document archive into a private sibling staging directory, rejects unsafe archive paths and symbolic links, and renames the staging directory into place only after PostgreSQL restores successfully.

If a failure occurs after the isolated database has been restored but before the storage namespace is installed, keep the recovered application offline, discard the isolated target, and repeat the restore from the verified backup. Do not attempt to merge a partial recovery into production.

After restore, set the recovered storage directory ownership/permissions expected by the deployment runtime before starting the application. For the production Docker image, the application process runs as UID `1001`.

## S3 / S3-compatible restore

The backup script does not copy S3 objects. The backup catalog must therefore retain the provider-native recovery point separately.

Restore the object-store snapshot/version into an **isolated recovery bucket/prefix first**, validate that recovery point, then acknowledge it:

```bash
export RESTORE_SOURCE_DIR=/srv/gmao/backups/gmao-20260808T120000Z
export RESTORE_DATABASE_URL='postgresql://restore_user:...@db.example/recovery?schema=public'
export RESTORE_ACKNOWLEDGE_ISOLATED_TARGET=true
export RESTORE_ACKNOWLEDGE_EXTERNAL_STORAGE_RESTORED=true

npm run restore:production
```

The script will then restore PostgreSQL. It does not perform provider-specific S3 rollback or copy operations itself.

## Verification before cutover

At minimum, verify the recovered deployment while it is still isolated:

```bash
DATABASE_URL="$RESTORE_DATABASE_URL" npm run prisma:status
DATABASE_URL="$RESTORE_DATABASE_URL" npm run test:db
```

Then verify application-level invariants relevant to the deployment, including:

- organization/site records are present;
- representative assets and work orders are present;
- current controlled-document metadata resolves to restored objects;
- controlled-document checksum verification succeeds on representative files;
- expected migration history is present;
- `/api/health` returns healthy after startup;
- `/api/ready` returns ready against the recovered database.

Do not enable user traffic until these checks pass.

## CI restore drill

The main CI workflow performs a real recovery drill on every change:

1. seed the normal disposable PostgreSQL database;
2. create a production-format backup with a synthetic controlled document;
3. create a second, empty PostgreSQL database;
4. restore the backup into that isolated database and a new storage directory;
5. compare Organization, Site, and WorkOrder row counts between source and restored databases;
6. verify the synthetic controlled document byte content;
7. run Prisma migration status and the DB smoke check against the restored database;
8. attempt a second restore and require it to fail because the target database is no longer empty.

This is a destructive-recovery test only against disposable CI resources. It must never target production credentials.

## Cutover pattern

Prefer **restore-and-switch** over in-place recovery:

1. stop or isolate writers to the failed environment;
2. restore DB and storage to new recovery resources;
3. verify integrity and migrations;
4. start application replicas against the recovered resources without public traffic;
5. verify health/readiness and representative controlled documents;
6. switch traffic/configuration to the recovered resources;
7. retain the failed environment until recovery is accepted and rollback decisions are complete.

This avoids making an already damaged production target harder to reason about.

## Secrets and logs

The restore script does not print `RESTORE_DATABASE_URL` or secret values. Do not enable shell tracing (`set -x`) around recovery commands. Treat backup and restored business data as sensitive production data even though credentials are stored separately.

## Relationship to upgrades

A restore returns data to the schema state captured by the backup. Do not silently apply new application migrations during the restore itself. Restore first, validate the recovered schema, then follow the separately documented E14 upgrade/migration procedure for any forward migration required by the release being deployed.
