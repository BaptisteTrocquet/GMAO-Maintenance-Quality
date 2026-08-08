import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

type PackageJson = {
  scripts?: Record<string, string>;
};

const root = process.cwd();
const migrationsRoot = path.join(root, "prisma", "migrations");
const INITIAL_MIGRATION = "00000000000000_init";
const DESTRUCTIVE_REVIEW_MARKER = "gmao: destructive-migration-reviewed";
const DOCKER_BUILDER_MARKER = "GMAO_DOCKER_BUILDER";

const forbiddenCommands = [
  /\bprisma\s+db\s+push\b/i,
  /\bprisma\s+migrate\s+reset\b/i,
];

const destructiveSqlPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { label: "DROP COLUMN", pattern: /\bDROP\s+COLUMN\b/i },
  { label: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
  { label: "DROP TYPE", pattern: /\bDROP\s+TYPE\b/i },
  { label: "ALTER COLUMN TYPE", pattern: /\bALTER\s+COLUMN\b[\s\S]{0,120}\bTYPE\b/i },
  { label: "DELETE without WHERE", pattern: /\bDELETE\s+FROM\s+[^;]+;/i },
];

function fail(message: string): never {
  throw new Error(`Upgrade policy check failed: ${message}`);
}

function checkPackageScripts(packageJson: PackageJson) {
  const scripts = packageJson.scripts ?? {};
  if (scripts["prisma:deploy"] !== "prisma migrate deploy") {
    fail('package.json must keep "prisma:deploy" mapped exactly to "prisma migrate deploy"');
  }
  if (!scripts["db:bootstrap"]?.includes("prisma:deploy")) {
    fail('"db:bootstrap" must apply committed migrations through "prisma:deploy"');
  }

  for (const [name, command] of Object.entries(scripts)) {
    for (const forbidden of forbiddenCommands) {
      if (forbidden.test(command)) fail(`script "${name}" contains forbidden command: ${command}`);
    }
  }
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function checkDockerRuntime() {
  const dockerfilePath = path.join(root, "Dockerfile");

  if (!(await fileExists(dockerfilePath))) {
    // Docker intentionally makes Dockerfile/.dockerignore unavailable to COPY inside
    // the build stages. The checkout-level prebuild in CI validates the real Dockerfile
    // immediately before the production image build. Only the explicit builder marker
    // may bypass this physically impossible in-image re-read.
    if (process.env[DOCKER_BUILDER_MARKER] === "1") return;
    fail("Dockerfile is missing; production runtime policy cannot be validated");
  }

  const dockerfile = await readFile(dockerfilePath, "utf8");
  const runtimeSection = dockerfile.split(/\nFROM\s+base\s+AS\s+runner\s*\n/i)[1];
  if (!runtimeSection) fail("Dockerfile runner stage could not be located");
  if (/prisma\s+(?:migrate|db\s+push)/i.test(runtimeSection)) {
    fail("production runtime image must not execute Prisma schema changes on application startup");
  }
  if (!/CMD\s*\[\s*"node"\s*,\s*"server\.js"\s*\]/.test(runtimeSection)) {
    fail("production runtime must start the standalone application directly");
  }
}

async function checkCommittedMigrations() {
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && entry.name !== INITIAL_MIGRATION)
    .map((entry) => entry.name)
    .sort();

  for (const migration of migrations) {
    const sqlPath = path.join(migrationsRoot, migration, "migration.sql");
    const sql = await readFile(sqlPath, "utf8");
    if (sql.includes(DESTRUCTIVE_REVIEW_MARKER)) continue;

    for (const { label, pattern } of destructiveSqlPatterns) {
      const match = sql.match(pattern);
      if (!match) continue;
      if (label === "DELETE without WHERE" && /\bDELETE\s+FROM\s+[^;]+\bWHERE\b/i.test(match[0])) {
        continue;
      }
      fail(
        `${migration}/migration.sql contains ${label}. ` +
          `Use an expand/contract migration or add "-- ${DESTRUCTIVE_REVIEW_MARKER}" only after ` +
          "documented backup, compatibility and rollback review.",
      );
    }
  }
}

async function main() {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as PackageJson;
  checkPackageScripts(packageJson);
  await checkDockerRuntime();
  await checkCommittedMigrations();
  process.stdout.write("Upgrade and migration policy check passed\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
