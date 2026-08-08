import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const upgrade = readFileSync(resolve(root, "docs/UPGRADE.md"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

function fencedCommands(markdown: string) {
  return [...markdown.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)]
    .flatMap((match) => match[1]!.split("\n"))
    .map((line) => line.trim().replace(/^\$\s*/, ""))
    .filter(Boolean);
}

describe("production upgrade and migration documentation", () => {
  it("documents the real committed-migration production commands", () => {
    expect(packageJson.scripts["prisma:deploy"]).toBe("prisma migrate deploy");
    expect(packageJson.scripts["prisma:status"]).toBe("prisma migrate status");
    expect(packageJson.scripts["db:bootstrap"]).toContain("prisma:seed");

    expect(upgrade).toContain("npm run prisma:deploy");
    expect(upgrade).toContain("npm run prisma:status");
    expect(upgrade).toContain("npm run test:db");
    expect(upgrade).toContain("npm run backup:production");
  });

  it("documents the expand/contract and restore-or-fix-forward strategy", () => {
    expect(upgrade).toMatch(/expand → deploy\/backfill → contract later/i);
    expect(upgrade).toContain("Application-only rollback");
    expect(upgrade).toContain("Fix forward");
    expect(upgrade).toContain("Restore-and-switch rollback");
    expect(upgrade).toContain("docs/RESTORE.md");
    expect(upgrade).toContain("Never edit, delete, reorder, or replace a migration");
    expect(upgrade).toContain("new committed Prisma migration");
  });

  it("requires health/readiness validation before broad traffic", () => {
    expect(upgrade).toContain("/api/health");
    expect(upgrade).toContain("/api/ready");
    expect(upgrade).toContain("Do not expose the full new fleet until readiness is stable");
  });

  it("never presents destructive development commands as runnable production steps", () => {
    const commands = fencedCommands(upgrade);
    const forbidden = [
      "prisma migrate dev",
      "prisma db push",
      "prisma migrate reset",
      "npm run db:bootstrap",
    ];

    for (const command of commands) {
      for (const fragment of forbidden) {
        expect(command).not.toMatch(new RegExp(`(^|\\s)${fragment.replaceAll(" ", "\\s+")}($|\\s)`));
      }
    }

    expect(upgrade).toContain(
      "Do not run `prisma migrate dev`, `prisma db push`, `prisma migrate reset`, or `db:bootstrap` in production.",
    );
  });

  it("does not falsely claim the previous-supported-release upgrade gate is complete", () => {
    expect(upgrade).toContain("Upgrade from previous supported release tested");
    expect(upgrade).toContain("does **not** by itself satisfy");
    expect(upgrade).toContain("release/versioning policy");
  });

  it("links the production runbook from the repository entry point", () => {
    expect(readme).toContain("[docs/UPGRADE.md](docs/UPGRADE.md)");
    expect(readme).toContain("clean-clone/development helper, not a production upgrade command");
  });
});
