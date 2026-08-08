import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDeploymentExamples,
  DeploymentExamplePolicyError,
} from "@/lib/deployment-example-policy";

const root = process.cwd();

async function loadExamples() {
  const [dockerfile, compose, kubernetesApp, kubernetesMigration] = await Promise.all([
    readFile(path.join(root, "Dockerfile"), "utf8"),
    readFile(path.join(root, "deploy/compose/docker-compose.production.yml"), "utf8"),
    readFile(path.join(root, "deploy/kubernetes/app.yaml"), "utf8"),
    readFile(path.join(root, "deploy/kubernetes/migrate-job.yaml"), "utf8"),
  ]);
  return { dockerfile, compose, kubernetesApp, kubernetesMigration };
}

describe("deployment example policy", () => {
  it("accepts the committed production examples", async () => {
    const examples = await loadExamples();
    expect(() => assertDeploymentExamples(examples)).not.toThrow();
  });

  it("rejects hard-coded database credentials", async () => {
    const examples = await loadExamples();
    examples.compose = examples.compose.replace(
      "${DATABASE_URL:?set DATABASE_URL in the external runtime environment}",
      "postgresql://admin:supersecret@db:5432/opengmao",
    );
    expect(() => assertDeploymentExamples(examples)).toThrow(DeploymentExamplePolicyError);
  });

  it("rejects a privileged Compose application service", async () => {
    const examples = await loadExamples();
    examples.compose = examples.compose.replace(
      "    init: true\n",
      "    init: true\n    privileged: true\n",
    );
    expect(() => assertDeploymentExamples(examples)).toThrow(/privileged/i);
  });

  it("rejects Kubernetes floating tags and committed Secret objects", async () => {
    const examples = await loadExamples();
    examples.kubernetesApp = examples.kubernetesApp
      .replace(
        /ghcr\.io\/example\/gmao-maintenance-quality@sha256:0{64}/,
        "ghcr.io/example/gmao-maintenance-quality:latest",
      )
      .concat("\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: bad\n");
    expect(() => assertDeploymentExamples(examples)).toThrow(DeploymentExamplePolicyError);
  });

  it("rejects swapped readiness and liveness paths", async () => {
    const examples = await loadExamples();
    examples.kubernetesApp = examples.kubernetesApp.replace(
      /readinessProbe:([\s\S]*?)path:\s*\/api\/ready/,
      "readinessProbe:$1path: /api/health",
    );
    expect(() => assertDeploymentExamples(examples)).toThrow(/readiness/i);
  });

  it("rejects migration jobs that stop using prisma migrate deploy", async () => {
    const examples = await loadExamples();
    examples.kubernetesMigration = examples.kubernetesMigration.replace("- deploy", "- reset");
    expect(() => assertDeploymentExamples(examples)).toThrow(/migrate deploy/i);
  });

  it("rejects migration images that stop pruning development dependencies", async () => {
    const examples = await loadExamples();
    examples.dockerfile = examples.dockerfile.replace(
      "npm prune --omit=dev --no-audit --no-fund",
      "npm --version",
    );
    expect(() => assertDeploymentExamples(examples)).toThrow(/prune/i);
  });

  it("rejects migration runtimes that inherit application builder output", async () => {
    const examples = await loadExamples();
    examples.dockerfile = examples.dockerfile.replace(
      "COPY --from=migration-deps --chown=nextjs:nodejs /app/node_modules ./node_modules",
      "COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules",
    );
    expect(() => assertDeploymentExamples(examples)).toThrow(/migration-deps|builder/i);
  });
});
