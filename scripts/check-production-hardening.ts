import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertProductionHardening } from "@/lib/production-hardening";

const root = process.cwd();

async function read(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function main() {
  // Docker intentionally excludes Dockerfile, .dockerignore and .github from COPY.
  // The checkout-level Next.js build runs this gate before docker build, so the
  // explicitly marked builder stage may skip the impossible in-image re-validation.
  if (process.env.GMAO_DOCKER_BUILDER === "1") {
    process.stdout.write("Production hardening policy already validated before Docker build\n");
    return;
  }

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
