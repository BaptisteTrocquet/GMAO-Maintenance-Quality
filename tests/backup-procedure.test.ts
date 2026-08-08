import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "backup-production.sh");
const temporaryRoots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "gmao-backup-test-"));
  temporaryRoots.push(root);
  return root;
}

function writeExecutable(filePath: string, content: string) {
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

function fakePostgresTools(root: string, options: { failDump?: boolean } = {}) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });

  writeExecutable(
    path.join(bin, "pg_dump"),
    `#!/usr/bin/env bash
set -eu
[ -z "\${PG_DUMP_MARKER:-}" ] || touch "$PG_DUMP_MARKER"
${options.failDump ? "exit 42" : ""}
out=""
for arg in "$@"; do
  case "$arg" in
    --file=*) out="\${arg#--file=}" ;;
  esac
done
[ -n "$out" ]
printf 'synthetic-postgres-custom-archive' > "$out"
`,
  );

  writeExecutable(
    path.join(bin, "pg_restore"),
    `#!/usr/bin/env bash
set -eu
last=""
for arg in "$@"; do last="$arg"; done
[ -s "$last" ]
printf 'synthetic archive listing\n'
`,
  );

  return bin;
}

function runBackup(root: string, env: Record<string, string>) {
  const result = spawnSync("bash", [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
  return result;
}

function mode(filePath: string) {
  return statSync(filePath).mode & 0o777;
}

afterEach(() => {
  while (temporaryRoots.length) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("production backup procedure", () => {
  it("creates a private, checksummed PostgreSQL and local-document backup without leaking the database URL", () => {
    const root = tempRoot();
    const bin = fakePostgresTools(root);
    const storageDir = path.join(root, "documents");
    const backupRoot = path.join(root, "backups");
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(path.join(storageDir, "synthetic-manual.txt"), "controlled synthetic content", "utf8");

    const secretUrl = "postgresql://backup_user:SUPER_SECRET@db.internal:5432/gmao";
    const result = runBackup(root, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DATABASE_URL: secretUrl,
      STORAGE_PROVIDER: "local",
      STORAGE_LOCAL_DIR: storageDir,
      BACKUP_ROOT: backupRoot,
      BACKUP_TIMESTAMP: "20260808T142100Z",
      BACKUP_ACKNOWLEDGE_QUIESCED: "true",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("SUPER_SECRET");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("db.internal");

    const backupDir = path.join(backupRoot, "gmao-20260808T142100Z");
    expect(existsSync(path.join(backupDir, "postgres.dump"))).toBe(true);
    expect(existsSync(path.join(backupDir, "documents.tar.gz"))).toBe(true);
    expect(existsSync(path.join(backupDir, "manifest.txt"))).toBe(true);
    expect(existsSync(path.join(backupDir, "SHA256SUMS"))).toBe(true);
    expect(mode(backupDir)).toBe(0o700);
    expect(mode(path.join(backupDir, "postgres.dump"))).toBe(0o600);
    expect(mode(path.join(backupDir, "documents.tar.gz"))).toBe(0o600);

    const manifest = readFileSync(path.join(backupDir, "manifest.txt"), "utf8");
    expect(manifest).toContain("storage_provider=local");
    expect(manifest).toContain("storage_archive=documents.tar.gz");
    expect(manifest).toContain("consistency=writers_quiesced");
    expect(manifest).not.toContain("SUPER_SECRET");
    expect(manifest).not.toContain("DATABASE_URL");

    const checksum = spawnSync("sha256sum", ["-c", "SHA256SUMS"], {
      cwd: backupDir,
      encoding: "utf8",
    });
    expect(checksum.status, checksum.stderr).toBe(0);

    const archive = spawnSync("tar", ["-tzf", "documents.tar.gz"], {
      cwd: backupDir,
      encoding: "utf8",
    });
    expect(archive.status, archive.stderr).toBe(0);
    expect(archive.stdout).toContain("synthetic-manual.txt");
  });

  it("refuses local-storage backup before any database dump unless writers were explicitly quiesced", () => {
    const root = tempRoot();
    const bin = fakePostgresTools(root);
    const storageDir = path.join(root, "documents");
    const marker = path.join(root, "pg-dump-called");
    mkdirSync(storageDir, { recursive: true });

    const result = runBackup(root, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DATABASE_URL: "postgresql://backup_user:SUPER_SECRET@db.internal:5432/gmao",
      STORAGE_PROVIDER: "local",
      STORAGE_LOCAL_DIR: storageDir,
      BACKUP_ROOT: path.join(root, "backups"),
      BACKUP_TIMESTAMP: "no-quiesce",
      PG_DUMP_MARKER: marker,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("BACKUP_ACKNOWLEDGE_QUIESCED=true");
    expect(result.stderr).not.toContain("SUPER_SECRET");
    expect(existsSync(marker)).toBe(false);
  });

  it("requires an external object-store snapshot acknowledgement for S3 deployments", () => {
    const root = tempRoot();
    const bin = fakePostgresTools(root);
    const marker = path.join(root, "pg-dump-called");

    const refused = runBackup(root, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DATABASE_URL: "postgresql://backup_user:SUPER_SECRET@db.internal:5432/gmao",
      STORAGE_PROVIDER: "s3",
      BACKUP_ROOT: path.join(root, "backups"),
      BACKUP_TIMESTAMP: "s3-refused",
      PG_DUMP_MARKER: marker,
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("BACKUP_ACKNOWLEDGE_EXTERNAL_STORAGE_SNAPSHOT=true");
    expect(existsSync(marker)).toBe(false);

    const accepted = runBackup(root, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DATABASE_URL: "postgresql://backup_user:SUPER_SECRET@db.internal:5432/gmao",
      STORAGE_PROVIDER: "s3-compatible",
      BACKUP_ROOT: path.join(root, "backups"),
      BACKUP_TIMESTAMP: "s3-accepted",
      BACKUP_ACKNOWLEDGE_EXTERNAL_STORAGE_SNAPSHOT: "true",
    });
    expect(accepted.status, accepted.stderr).toBe(0);

    const backupDir = path.join(root, "backups", "gmao-s3-accepted");
    expect(existsSync(path.join(backupDir, "documents.tar.gz"))).toBe(false);
    const manifest = readFileSync(path.join(backupDir, "manifest.txt"), "utf8");
    expect(manifest).toContain("storage_archive=external-provider-snapshot");
    expect(manifest).toContain("consistency=external_snapshot_acknowledged");
  });

  it("removes partial output when pg_dump fails", () => {
    const root = tempRoot();
    const bin = fakePostgresTools(root, { failDump: true });
    const storageDir = path.join(root, "documents");
    const backupRoot = path.join(root, "backups");
    mkdirSync(storageDir, { recursive: true });

    const result = runBackup(root, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DATABASE_URL: "postgresql://backup_user:SUPER_SECRET@db.internal:5432/gmao",
      STORAGE_PROVIDER: "local",
      STORAGE_LOCAL_DIR: storageDir,
      BACKUP_ROOT: backupRoot,
      BACKUP_TIMESTAMP: "dump-failure",
      BACKUP_ACKNOWLEDGE_QUIESCED: "true",
    });

    expect(result.status).toBe(42);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("SUPER_SECRET");
    expect(existsSync(path.join(backupRoot, "gmao-dump-failure.partial"))).toBe(false);
    expect(existsSync(path.join(backupRoot, "gmao-dump-failure"))).toBe(false);
  });
});
