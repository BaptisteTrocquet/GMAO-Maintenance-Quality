import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function readRepositoryFile(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const compose = readRepositoryFile("deploy/compose/docker-compose.production.yml");
const kubernetesApp = readRepositoryFile("deploy/kubernetes/app.yaml");
const kubernetesMigration = readRepositoryFile("deploy/kubernetes/migrate-job.yaml");
const deploymentGuide = readRepositoryFile("docs/DEPLOYMENT.md");

describe("production deployment examples", () => {
  it("keeps the Compose database private and runtime secrets external", () => {
    const databaseSection = compose.split("\n  migrate:")[0];

    expect(databaseSection).not.toMatch(/\n\s+ports:/);
    expect(compose).toContain("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?");
    expect(compose).toContain("DATABASE_URL: ${DATABASE_URL:?");
    expect(compose).not.toContain("postgresql://");
    expect(compose).toContain("${OPENGMAO_BIND_ADDRESS:-127.0.0.1}");
  });

  it("separates the hardened application runtime from migration tooling in Compose", () => {
    expect(compose).toContain('command: ["npm", "run", "prisma:deploy"]');
    expect(compose).toContain('user: "1001:1001"');
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("cap_drop:");
    expect(compose).toContain("STORAGE_LOCAL_DIR: /app/data/documents");
    expect(compose).toContain("RATE_LIMIT_TRUST_PROXY_HOPS: ${RATE_LIMIT_TRUST_PROXY_HOPS:-0}");
    expect(compose).not.toContain("prisma db push");
    expect(compose).not.toContain("prisma migrate reset");
  });

  it("keeps Kubernetes secrets out of the repository and configures safe probes", () => {
    expect(kubernetesApp).not.toContain("kind: Secret");
    expect(kubernetesApp).toContain("secretKeyRef:");
    expect(kubernetesApp).toContain("name: opengmao-runtime");
    expect(kubernetesApp).toContain("key: DATABASE_URL");
    expect(kubernetesApp).toContain("runAsNonRoot: true");
    expect(kubernetesApp).toContain("runAsUser: 1001");
    expect(kubernetesApp).toContain("allowPrivilegeEscalation: false");
    expect(kubernetesApp).toContain("automountServiceAccountToken: false");
    expect(kubernetesApp).toMatch(/livenessProbe:[\s\S]*path: \/api\/health/);
    expect(kubernetesApp).toMatch(/readinessProbe:[\s\S]*path: \/api\/ready/);
    expect(kubernetesApp).toContain("type: ClusterIP");
    expect(kubernetesApp).not.toContain("type: LoadBalancer");
    expect(kubernetesApp).not.toContain("type: NodePort");
  });

  it("keeps the default Kubernetes local-storage deployment single-replica", () => {
    expect(kubernetesApp).toContain("replicas: 1");
    expect(kubernetesApp).toContain("type: Recreate");
    expect(kubernetesApp).toContain("kind: PersistentVolumeClaim");
    expect(kubernetesApp).toContain("ReadWriteOnce");
    expect(kubernetesApp).toContain("mountPath: /app/data");
    expect(kubernetesApp).toContain('value: "0"');
  });

  it("runs Kubernetes migrations as an isolated non-root release job", () => {
    expect(kubernetesMigration).toContain("kind: Job");
    expect(kubernetesMigration).not.toContain("kind: Secret");
    expect(kubernetesMigration).toContain("ghcr.io/example/gmao-maintenance-quality-migrations:REPLACE_WITH_RELEASE");
    expect(kubernetesMigration).toContain("./node_modules/.bin/prisma");
    expect(kubernetesMigration).toContain("- migrate\n            - deploy");
    expect(kubernetesMigration).toContain("runAsNonRoot: true");
    expect(kubernetesMigration).toContain("runAsUser: 1001");
    expect(kubernetesMigration).toContain("readOnlyRootFilesystem: true");
    expect(kubernetesMigration).toContain("allowPrivilegeEscalation: false");
    expect(kubernetesMigration).toContain("automountServiceAccountToken: false");
    expect(kubernetesMigration).toContain("secretKeyRef:");
    expect(kubernetesMigration).not.toContain("prisma db push");
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
    ]) {
      expect(deploymentGuide).toContain(requiredReference);
    }

    expect(deploymentGuide).toContain("Do not commit production `.env` files");
    expect(deploymentGuide).toContain("immutable release tags or digests");
  });

  it("does not use floating latest tags in committed deployment manifests", () => {
    expect(`${compose}\n${kubernetesApp}\n${kubernetesMigration}`).not.toMatch(/image:\s+\S+:latest\b/);
  });
});
