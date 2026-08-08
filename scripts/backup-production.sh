#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

fail() {
  printf 'Backup failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is required"

storage_provider="${STORAGE_PROVIDER:-local}"
case "$storage_provider" in
  local)
    [ "${BACKUP_ACKNOWLEDGE_QUIESCED:-false}" = "true" ] || \
      fail "local-storage backup requires BACKUP_ACKNOWLEDGE_QUIESCED=true after application writers are quiesced"
    storage_dir="${STORAGE_LOCAL_DIR:-./data/documents}"
    [ -d "$storage_dir" ] || fail "STORAGE_LOCAL_DIR does not exist or is not a directory"
    require_command tar
    require_command realpath
    ;;
  s3|s3-compatible)
    [ "${BACKUP_ACKNOWLEDGE_EXTERNAL_STORAGE_SNAPSHOT:-false}" = "true" ] || \
      fail "S3 backup requires BACKUP_ACKNOWLEDGE_EXTERNAL_STORAGE_SNAPSHOT=true after a provider-native object snapshot/version is secured"
    storage_dir=""
    ;;
  *)
    fail "unsupported STORAGE_PROVIDER"
    ;;
esac

require_command pg_dump
require_command pg_restore
require_command sha256sum
require_command date

backup_root="${BACKUP_ROOT:-./backups}"
backup_timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"

case "$backup_timestamp" in
  *[!0-9A-Za-z._-]*|'') fail "BACKUP_TIMESTAMP contains unsupported characters" ;;
esac

mkdir -p "$backup_root"
chmod 700 "$backup_root" 2>/dev/null || true

if [ "$storage_provider" = "local" ]; then
  storage_real="$(realpath -m "$storage_dir")"
  backup_root_real="$(realpath -m "$backup_root")"
  case "$backup_root_real" in
    "$storage_real"|"$storage_real"/*)
      fail "BACKUP_ROOT must not be inside STORAGE_LOCAL_DIR"
      ;;
  esac
fi

final_dir="${backup_root%/}/gmao-${backup_timestamp}"
partial_dir="${final_dir}.partial"

[ ! -e "$final_dir" ] || fail "backup destination already exists"
[ ! -e "$partial_dir" ] || fail "partial backup destination already exists"

cleanup_partial() {
  rm -rf "$partial_dir"
}
trap cleanup_partial EXIT HUP INT TERM

mkdir -p "$partial_dir"
chmod 700 "$partial_dir"

database_dump="$partial_dir/postgres.dump"
pg_dump \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$database_dump"

# A custom-format archive should be parseable before it is accepted as a backup artifact.
pg_restore --list "$database_dump" >/dev/null

storage_archive="none"
consistency_mode="database_only"

if [ "$storage_provider" = "local" ]; then
  storage_archive="documents.tar.gz"
  consistency_mode="writers_quiesced"
  tar \
    --create \
    --gzip \
    --file="$partial_dir/$storage_archive" \
    --directory="$storage_dir" \
    .
else
  storage_archive="external-provider-snapshot"
  consistency_mode="external_snapshot_acknowledged"
fi

cat > "$partial_dir/manifest.txt" <<EOF
format_version=1
created_at_utc=$backup_timestamp
database_dump=postgres.dump
storage_provider=$storage_provider
storage_archive=$storage_archive
consistency=$consistency_mode
EOF

(
  cd "$partial_dir"
  checksum_files=(postgres.dump manifest.txt)
  if [ -f documents.tar.gz ]; then
    checksum_files+=(documents.tar.gz)
  fi
  sha256sum "${checksum_files[@]}" > SHA256SUMS
)

chmod 600 "$partial_dir"/*

mv "$partial_dir" "$final_dir"
trap - EXIT HUP INT TERM

printf 'Backup created: %s\n' "$final_dir"
