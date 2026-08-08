import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const MIGRATION_DIR_PATTERN = /^\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const SAFETY_REVIEW_MARKER = "Migration safety review: APPROVED";

const BACKWARDS_INCOMPATIBLE_PATTERNS = [
  { label: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { label: "DROP COLUMN", pattern: /\bDROP\s+COLUMN\b/i },
  { label: "TRUNCATE", pattern: /\bTRUNCATE(?:\s+TABLE)?\b/i },
  { label: "DROP TYPE", pattern: /\bDROP\s+TYPE\b/i },
  { label: "DROP CONSTRAINT", pattern: /\bDROP\s+CONSTRAINT\b/i },
  { label: "RENAME COLUMN", pattern: /\bRENAME\s+COLUMN\b/i },
  {
    label: "ALTER COLUMN TYPE",
    pattern: /\bALTER\s+TABLE\b[\s\S]{0,300}\bALTER\s+COLUMN\b[\s\S]{0,160}\bTYPE\b/i,
  },
];

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stripSqlComments(sql: string) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ");
}

function fail(message: string): never {
  throw new Error(`Migration policy violation: ${message}`);
}

async function main() {
  const root = process.cwd();
  const migrationsRoot = path.join(root, "prisma", "migrations");
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  const migrationDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (migrationDirs.length === 0) {
    fail("no committed migration directories were found");
  }

  for (const migrationDir of migrationDirs) {
    if (!MIGRATION_DIR_PATTERN.test(migrationDir)) {
      fail(`${migrationDir} does not use the required timestamp_name directory format`);
    }

    const directory = path.join(migrationsRoot, migrationDir);
    const sqlPath = path.join(directory, "migration.sql");
    const downPath = path.join(directory, "down.sql");

    if (!(await exists(sqlPath))) {
      fail(`${migrationDir} is missing migration.sql`);
    }
    if (await exists(downPath)) {
      fail(`${migrationDir} contains down.sql; production rollback is restore-or-forward-fix, not down migrations`);
    }

    const sql = await readFile(sqlPath, "utf8");
    if (!sql.trim()) {
      fail(`${migrationDir}/migration.sql is empty`);
    }

    // The initial schema is a bootstrap baseline rather than an in-place production upgrade.
    if (migrationDir === "00000000000000_init") continue;

    const executableSql = stripSqlComments(sql);
    const findings = BACKWARDS_INCOMPATIBLE_PATTERNS.filter(({ pattern }) =>
      pattern.test(executableSql),
    ).map(({ label }) => label);

    if (findings.length > 0) {
      const safetyPath = path.join(directory, "SAFETY.md");
      if (!(await exists(safetyPath))) {
        fail(
          `${migrationDir} contains potentially destructive/backwards-incompatible SQL (${findings.join(", ")}) but has no SAFETY.md review`,
        );
      }
      const safetyReview = await readFile(safetyPath, "utf8");
      if (!safetyReview.includes(SAFETY_REVIEW_MARKER)) {
        fail(`${migrationDir}/SAFETY.md must contain exact marker: ${SAFETY_REVIEW_MARKER}`);
      }
    }
  }

  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};

  if (scripts["prisma:deploy"] !== "prisma migrate deploy") {
    fail('package script "prisma:deploy" must remain exactly "prisma migrate deploy"');
  }

  for (const [name, command] of Object.entries(scripts)) {
    if (/\bprisma\s+db\s+push\b/i.test(command)) {
      fail(`package script ${name} uses prisma db push`);
    }
    if (/\bprisma\s+migrate\s+reset\b/i.test(command)) {
      fail(`package script ${name} uses prisma migrate reset`);
    }
  }

  console.log(
    `Migration policy check passed for ${migrationDirs.length} committed migration(s).`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown migration policy failure";
  console.error(message);
  process.exitCode = 1;
});
