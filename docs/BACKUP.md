# Production backup procedure

This procedure backs up the state required to recover a GMAO Maintenance Quality deployment without putting credentials into the repository or backup manifest.

A complete deployment backup consists of:

1. a PostgreSQL custom-format dump;
2. controlled-document/object storage at a matching consistency point;
3. the generated manifest and SHA-256 checksum file;
4. separately managed deployment secrets and infrastructure configuration.

Backups contain production business data and must be treated as sensitive data. Never commit them to Git.

## Consistency boundary

PostgreSQL metadata and controlled-document files form one logical application state. A database dump combined with an unrelated storage copy can produce references to missing or mismatched objects.

For `STORAGE_PROVIDER=local`, quiesce application writers before starting the backup and keep them quiesced until the script completes. Then set:

```bash
export BACKUP_ACKNOWLEDGE_QUIESCED=true
```

The script refuses to create a local-storage backup without that explicit acknowledgement.

For `STORAGE_PROVIDER=s3` or `s3-compatible`, first secure a provider-native object-store snapshot/versioned recovery point according to the storage provider's operational tooling. Then set:

```bash
export BACKUP_ACKNOWLEDGE_EXTERNAL_STORAGE_SNAPSHOT=true
```

The script records that acknowledgement but does not copy S3 objects itself. This prevents a PostgreSQL-only dump from being mistaken for a complete application backup.

## Prerequisites

The host running the backup needs:

- Bash;
- `pg_dump` and `pg_restore` compatible with the PostgreSQL server version;
- `sha256sum`;
- `tar` and `realpath` for local-storage deployments.

`DATABASE_URL` is supplied at runtime. Do not paste credentials into the script or repository.

Use a dedicated backup identity with only the database privileges required to read/dump the application database. Store its secret in the deployment secret manager.

## Run a local-storage backup

After application writers are quiesced:

```bash
export DATABASE_URL='postgresql://...'
export STORAGE_PROVIDER=local
export STORAGE_LOCAL_DIR=/srv/gmao/documents
export BACKUP_ROOT=/srv/gmao/backups
export BACKUP_ACKNOWLEDGE_QUIESCED=true
npm run backup:production
```

The output directory is named `gmao-<UTC timestamp>` and is created with private permissions.

It contains:

```text
postgres.dump
documents.tar.gz
manifest.txt
SHA256SUMS
```

The PostgreSQL archive is generated in custom format with ownership and ACL restoration disabled. `pg_restore --list` must be able to parse it before the backup is accepted.

## Run with S3-compatible storage

First create or identify the object-store recovery point using the provider's snapshot/versioning/replication controls. Then:

```bash
export DATABASE_URL='postgresql://...'
export STORAGE_PROVIDER=s3
export BACKUP_ROOT=/srv/gmao/backups
export BACKUP_ACKNOWLEDGE_EXTERNAL_STORAGE_SNAPSHOT=true
npm run backup:production
```

The resulting manifest records `storage_archive=external-provider-snapshot`. Operators must retain the provider-side recovery-point identifier in the backup catalog/runbook outside the repository.

## Verify every backup

The script already validates the PostgreSQL archive structure and writes checksums. An operator or scheduled job should additionally verify the artifact after copying it to durable storage:

```bash
cd /srv/gmao/backups/gmao-<timestamp>
sha256sum -c SHA256SUMS
pg_restore --list postgres.dump >/dev/null
```

For local storage, also verify that the archive can be listed:

```bash
tar -tzf documents.tar.gz >/dev/null
```

A checksum-only success is not a restore test. The E14 restore procedure and restore drill are tracked separately and must restore into an isolated PostgreSQL instance and storage namespace.

## Scheduling and retention

A production operator should define an explicit RPO/RTO and retention policy. Recommended controls include:

- scheduled backups outside the repository/worktree;
- encryption at rest and in transit;
- access restricted to backup operators;
- at least one off-host/off-site copy;
- immutable or object-locked copies where available;
- periodic restore drills;
- monitoring for missed or failed backup runs;
- retention that covers both routine recovery and compliance needs.

Do not place `BACKUP_ROOT` inside `STORAGE_LOCAL_DIR`; the script rejects that configuration to avoid recursively archiving prior backups.

## Secrets and configuration

The backup manifest intentionally excludes:

- `DATABASE_URL`;
- database passwords;
- OIDC client secrets;
- connector vault master keys;
- S3 access keys/session tokens;
- API keys, webhook secrets, or browser tokens.

Those values must be backed up through the secret-management system, with independent access controls and rotation procedures.

## Failure behavior

The script writes into a `.partial` directory and removes it if any required step fails. The directory is renamed to its final `gmao-<timestamp>` name only after the database archive, storage step, manifest, and checksums all succeed.

The script never prints the database connection URL. Do not run it with shell tracing such as `set -x`, which could expose environment values in operator logs.
