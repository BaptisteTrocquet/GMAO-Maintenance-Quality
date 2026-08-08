import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertDeploymentExamples, DeploymentExamplePolicyError } from "@/lib/deployment-example-policy";

function readRepositoryFile(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const dockerfile = readRepositoryFile("Dockerfile");
const compose = readRepositoryFile("deploy/compose/docker-compose.production.yml");
const kubernetesApp = readRepositoryFile("deploy/kubernetes/app.yaml");
const kubernetesMigration = readRepositoryFile("deploy/kubernetes/migrate-job.yaml");
const deploymentGuide = readRepositoryFile("docs/DEPLOYMENT.md");

const examples = {
  dockerfile,
  compose,
  kubernetesApp,
  kubernetesMigration,
};

describe("production deployment examples", () => {
  it("satisfies the canonical deployment safety policy", () => {
    expect(() => assertDeploymentExamples(examples)).not.toThrow();
  });

  it("fails closed if a literal database credential is committed", () => {
    expect(() =>
      assertDeploymentExamples({
        ...examples,
        compose: compose.replace(
          "DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL in the external runtime environment}",
          "DATABASE_URL: postgresql://admin:unsafe-password@example.invalid:5432/opengmao",
        ),
      }),
    ).toThrow(DeploymentExamplePolicyError);
  });

  it("fails closed if Kubernetes application images drift back to a floating tag", () => {
    expect(() =>
      assertDeploymentExamples({
        ...examples,
        kubernetesApp: kubernetesApp.replace(
          /ghcr\.io\/example\/gmao-maintenance-quality@sha256:0{64}/,
          "ghcr.io/example/gmao-maintenance-quality:latest",
        ),
      }),
    ).toThrow(DeploymentExamplePolicyError);
  });

  it("keeps migration tooling separate from the hardened application runtime", () => {
    expect(dockerfile).toContain("FROM deps AS migration-deps");
    expect(dockerfile).toContain("npm prune --omit=dev --no-audit --no-fund");
    expect(dockerfile).toContain("FROM base AS migration");
    expect(dockerfile).toContain(
      "COPY --from=migration-deps --chown=nextjs:nodejs /app/node_modules ./node_modules",
    );
    expect(dockerfile).not.toMatch(/FROM builder AS migration\b/);
    expect(dockerfile).toContain('CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]');
    expect(compose).toContain('command: ["./node_modules/.bin/prisma", "migrate", "deploy"]');
    expect(kubernetesMigration).toContain('"migration"');
    expect(compose).not.toContain("prisma db push");
    expect(kubernetesMigration).not.toContain("prisma migrate reset");
  });

  it("documents the production security, migration, backup and recovery boundaries", () => {
    for (const requiredReference of [
      "PRODUCTION_HARDENING.md",
      "UPGRADING.md",
      "BACKUP.md",
      "RESTORE.md",
      "/api/health",
      "/api/ready",
      "/api/metrics",
      "RATE_LIMIT_TRUST_PROXY_HOPS",
      "--target migration",
    ]) {
      expect(deploymentGuide).toContain(requiredReference);
    }

    expect(deploymentGuide).toContain("Do not commit production `.env` files");
    expect(deploymentGuide).toContain("immutable release tags or digests");
  });
});
