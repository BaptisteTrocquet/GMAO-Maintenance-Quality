import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertProductionHardening } from "@/lib/production-hardening";

const root = process.cwd();

async function read(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function main() {
  assertProductionHardening({
    dockerfile: await read("Dockerfile"),
    dockerignore: await read(".dockerignore"),
    envExample: await read(".env.example"),
    rateLimitSource: await read("lib/rate-limit.ts"),
    nextConfig: await read("next.config.ts"),
    ciWorkflow: await read(".github/workflows/ci.yml"),
  });
  process.stdout.write("Production hardening policy check passed\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
