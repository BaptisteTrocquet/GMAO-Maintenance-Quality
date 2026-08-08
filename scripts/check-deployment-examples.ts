import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertDeploymentExamples } from "@/lib/deployment-example-policy";

const root = process.cwd();

async function read(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function main() {
  assertDeploymentExamples({
    compose: await read("deploy/compose/docker-compose.production.yml"),
    kubernetesApp: await read("deploy/kubernetes/app.yaml"),
    kubernetesMigration: await read("deploy/kubernetes/migrate-job.yaml"),
  });
  process.stdout.write("Deployment example policy check passed\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
