#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

fail() {
  printf 'Restore failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

[ -n "${RESTORE_SOURCE_DIR:-}" ] || fail "RESTORE_SOURCE_DIR is required"
[ -n "${RESTORE_DATABASE_URL:-}" ] || fail "RESTORE_DATABASE_URL is required"
[ "${RESTORE_ACKNOWLEDGE_ISOLATED_TARGET:-false}" = "true" ] || \
  fail "RESTORE_ACKNOWLEDGE_ISOLATED_TARGET=true is required for an empty isolated restore target"

require_command node
require_command pg_restore
require_command psql
require_command sha256sum
require_command awk
require_command grep
require_command find
require_command tar
require_command realpath

source_dir="$(realpath -m "$RESTORE_SOURCE_DIR")"
[ -d "$source_dir" ] || fail "RESTORE_SOURCE_DIR does not exist or is not a directory"

for required_file in manifest.txt SHA256SUMS postgres.dump; do
  [ -f "$source_dir/$required_file" ] || fail "$required_file is missing from the backup"
done

manifest_value() {
  local key="$1"
  local count
  count="$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$source_dir/manifest.txt")"
  [ "$count" = "1" ] || fail "manifest key $key must appear exactly once"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print }' "$source_dir/manifest.txt"
}

format_version="$(manifest_value format_version)"
[ "$format_version" = "1" ] || fail "unsupported backup manifest format_version"

database_dump="$(manifest_value database_dump)"
[ "$database_dump" = "postgres.dump" ] || fail "unsupported database_dump in manifest"

database_schema="$(manifest_value database_schema)"
case "$database_schema" in
  all) ;;
  ''|*[!A-Za-z0-9_]*) fail "database_schema contains unsupported characters" ;;
esac

storage_provider="$(manifest_value storage_provider)"
storage_archive="$(manifest_value storage_archive)"

case "$storage_provider" in
  local)
    [ "$storage_archive" = "documents.tar.gz" ] || fail "local backup is missing the expected storage archive"
    [ -f "$source_dir/documents.tar.gz" ] || fail "documents.tar.gz is missing from the backup"
    ;;
  s3|s3-compatible)
    [ "$storage_archive" = "external-provider-snapshot" ] || fail "unexpected external storage manifest entry"
    [ "${RESTORE_ACKNOWLEDGE_EXTERNAL_STORAGE_RESTORED:-false}" = "true" ] || \
      fail "external storage must be restored to an isolated recovery point before the database restore"
    ;;
  *)
    fail "unsupported storage_provider in backup manifest"
    ;;
esac

# Validate the complete artifact before making any changes to the target.
(
  cd "$source_dir"
  sha256sum -c SHA256SUMS
  pg_restore --list postgres.dump >/dev/null
  if [ "$storage_provider" = "local" ]; then
    tar -tzf documents.tar.gz >/dev/null
  fi
)

pg_database_url="$(RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" node -e '
  const url = new URL(process.env.RESTORE_DATABASE_URL);
  url.searchParams.delete("schema");
  process.stdout.write(url.toString());
')"
target_schema="$(RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" node -e '
  const url = new URL(process.env.RESTORE_DATABASE_URL);
  process.stdout.write(url.searchParams.get("schema") ?? "");
')"

if [ "$database_schema" != "all" ]; then
  [ -n "$target_schema" ] || fail "target DATABASE_URL must name the backup schema"
  [ "$target_schema" = "$database_schema" ] || fail "target schema does not match the backup manifest"
fi

if [ "$database_schema" = "all" ]; then
  target_table_count="$(
    psql \
      --dbname="$pg_database_url" \
      --tuples-only \
      --no-align \
      --set=ON_ERROR_STOP=1 \
      --command="SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');" \
      | tr -d '[:space:]'
  )"
else
  target_table_count="$(
    psql \
      --dbname="$pg_database_url" \
      --tuples-only \
      --no-align \
      --set=ON_ERROR_STOP=1 \
      --command="SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = '$database_schema';" \
      | tr -d '[:space:]'
  )"
fi

[ "$target_table_count" = "0" ] || \
  fail "target database/schema is not empty; restore refuses to overwrite existing application data"

storage_target=""
storage_stage=""
cleanup_stage() {
  if [ -n "$storage_stage" ] && [ -d "$storage_stage" ]; then
    rm -rf "$storage_stage"
  fi
}
trap cleanup_stage EXIT HUP INT TERM

if [ "$storage_provider" = "local" ]; then
  [ -n "${RESTORE_STORAGE_DIR:-}" ] || fail "RESTORE_STORAGE_DIR is required for local-storage backups"
  storage_target="$(realpath -m "$RESTORE_STORAGE_DIR")"
  [ ! -e "$storage_target" ] || fail "RESTORE_STORAGE_DIR must not already exist"

  storage_parent="$(dirname "$storage_target")"
  mkdir -p "$storage_parent"
  [ -d "$storage_parent" ] && [ -w "$storage_parent" ] || fail "RESTORE_STORAGE_DIR parent is not writable"

  storage_stage="${storage_target}.partial.$$"
  [ ! -e "$storage_stage" ] || fail "restore staging directory already exists"
  mkdir -p "$storage_stage"
  chmod 700 "$storage_stage"

  while IFS= read -r archive_entry; do
    case "$archive_entry" in
      /*|../*|*/../*|..)
        fail "documents archive contains an unsafe path"
        ;;
    esac
  done < <(tar -tzf "$source_dir/documents.tar.gz")

  tar \
    --extract \
    --gzip \
    --file="$source_dir/documents.tar.gz" \
    --directory="$storage_stage" \
    --no-same-owner \
    --no-same-permissions

  if find "$storage_stage" -type l -print -quit | grep -q .; then
    fail "documents archive contains symbolic links"
  fi
  chmod -R u+rwX,go-rwx "$storage_stage"
fi

# The target must be isolated and empty. --single-transaction makes the PostgreSQL
# restore atomic: a failed pg_restore does not leave a partially restored schema.
pg_restore \
  --dbname="$pg_database_url" \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-privileges \
  "$source_dir/postgres.dump"

if [ "$storage_provider" = "local" ]; then
  mv "$storage_stage" "$storage_target"
  storage_stage=""
fi

trap - EXIT HUP INT TERM
unset pg_database_url

printf 'Restore completed successfully from: %s\n' "$source_dir"
if [ "$storage_provider" = "local" ]; then
  printf 'Local document storage restored to: %s\n' "$storage_target"
else
  printf 'External object storage recovery point acknowledged as restored.\n'
fi
