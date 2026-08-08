type DeploymentExamples = {
  dockerfile: string;
  compose: string;
  kubernetesApp: string;
  kubernetesMigration: string;
};

export class DeploymentExamplePolicyError extends Error {
  constructor(message: string) {
    super(`Deployment example policy failed: ${message}`);
    this.name = "DeploymentExamplePolicyError";
  }
}

function requirePattern(content: string, pattern: RegExp, message: string) {
  if (!pattern.test(content)) throw new DeploymentExamplePolicyError(message);
}

function forbidPattern(content: string, pattern: RegExp, message: string) {
  if (pattern.test(content)) throw new DeploymentExamplePolicyError(message);
}

function composeService(compose: string, service: string) {
  const marker = `  ${service}:\n`;
  const start = compose.indexOf(marker);
  if (start < 0) throw new DeploymentExamplePolicyError(`Compose service ${service} is missing`);
  const bodyStart = start + marker.length;
  const remainder = compose.slice(bodyStart);
  const nextService = remainder.search(/\n  [A-Za-z0-9_-]+:\n|\nvolumes:\n/);
  return nextService < 0 ? remainder : remainder.slice(0, nextService);
}

function dockerStage(dockerfile: string, marker: RegExp) {
  const match = marker.exec(dockerfile);
  if (!match || match.index === undefined) return "";
  const remainder = dockerfile.slice(match.index + match[0].length);
  const nextStage = remainder.search(/\nFROM\s+/i);
  return nextStage < 0 ? remainder : remainder.slice(0, nextStage);
}

function assertNoCommittedSecrets(label: string, content: string) {
  const forbidden: Array<[RegExp, string]> = [
    [/postgres(?:ql)?:\/\/[^\s:$/{]+:[^\s@${}]+@/i, "literal PostgreSQL credentials"],
    [/\bgmao_sk_[A-Za-z0-9_-]{8,}/, "API key"],
    [/\bwhsec_[A-Za-z0-9_-]{8,}/, "webhook secret"],
    [/\bBearer\s+[A-Za-z0-9._~-]{12,}/i, "Bearer token"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, "JWT"],
    [/CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64\s*:\s*["']?[A-Za-z0-9+/=]{20,}/, "vault key"],
    [/STORAGE_S3_SECRET_ACCESS_KEY\s*:\s*["']?(?!\$\{|valueFrom:)[^\s#"']{8,}/, "S3 secret"],
  ];

  for (const [pattern, description] of forbidden) {
    if (pattern.test(content)) {
      throw new DeploymentExamplePolicyError(`${label} contains a committed ${description}`);
    }
  }
}

function assertDockerfile(dockerfile: string) {
  const migration = dockerStage(dockerfile, /FROM\s+builder\s+AS\s+migration\s*\n/i);
  if (!migration) throw new DeploymentExamplePolicyError("Dockerfile must define a migration target");

  requirePattern(migration, /HOME=\/tmp/, "migration image must use writable /tmp as HOME");
  requirePattern(migration, /^\s*USER\s+nextjs\s*$/m, "migration image must run as non-root nextjs user");
  requirePattern(
    migration,
    /CMD\s*\["\.\/node_modules\/\.bin\/prisma",\s*"migrate",\s*"deploy"\]/,
    "migration image must default to prisma migrate deploy",
  );
  requirePattern(
    migration,
    /rm\s+-rf[^\n]*\/usr\/local\/lib\/node_modules\/npm/,
    "migration runtime must remove the global npm package manager",
  );
}

function assertCompose(compose: string) {
  const db = composeService(compose, "db");
  const migrate = composeService(compose, "migrate");
  const app = composeService(compose, "app");

  requirePattern(db, /POSTGRES_IMAGE:\?/, "Compose must require an operator-selected PostgreSQL image");
  requirePattern(
    db,
    /POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:\?/,
    "Compose must require POSTGRES_PASSWORD from the external runtime environment",
  );
  forbidPattern(db, /^\s{4}ports:/m, "Compose must not publish PostgreSQL on the host");

  requirePattern(
    migrate,
    /OPENGMAO_MIGRATION_IMAGE:\?/,
    "Compose must require the migration image for the reviewed release",
  );
  requirePattern(
    migrate,
    /DATABASE_URL:\s*\$\{DATABASE_URL:\?/,
    "Compose migration service must require DATABASE_URL from the runtime environment",
  );
  requirePattern(
    migrate,
    /profiles:\s*\["migrate"\]/,
    "Compose migration execution must remain an explicit profile",
  );
  requirePattern(
    migrate,
    /command:\s*\["\.\/node_modules\/\.bin\/prisma",\s*"migrate",\s*"deploy"\]/,
    "Compose migration service must run prisma migrate deploy directly",
  );
  requirePattern(migrate, /user:\s*"1001:1001"/, "Compose migration service must run as UID/GID 1001");
  requirePattern(migrate, /read_only:\s*true/, "Compose migration service must use a read-only root filesystem");

  requirePattern(app, /OPENGMAO_IMAGE:\?/, "Compose must require the reviewed application image");
  requirePattern(
    app,
    /DATABASE_URL:\s*\$\{DATABASE_URL:\?/,
    "Compose application must require DATABASE_URL from the runtime environment",
  );
  requirePattern(app, /user:\s*"1001:1001"/, "Compose application must run as UID/GID 1001");
  requirePattern(
    app,
    /OPENGMAO_BIND_ADDRESS:-127\.0\.0\.1/,
    "Compose must bind to loopback by default instead of all host interfaces",
  );
  requirePattern(
    app,
    /RATE_LIMIT_ENABLED:\s*\$\{RATE_LIMIT_ENABLED:-true\}/,
    "Compose must keep application rate limiting enabled by default",
  );
  requirePattern(app, /opengmao_documents:\/app\/data/, "Compose must persist local controlled-document storage");
  requirePattern(app, /\/api\/health/, "Compose application healthcheck must use /api/health");

  for (const [name, service] of [
    ["migrate", migrate],
    ["app", app],
  ] as const) {
    requirePattern(service, /no-new-privileges:true/, `Compose ${name} must use no-new-privileges`);
    requirePattern(service, /cap_drop:\s*\n\s*- ALL/, `Compose ${name} must drop Linux capabilities`);
    forbidPattern(service, /privileged:\s*true/i, `Compose ${name} must never run privileged`);
    forbidPattern(service, /network_mode:\s*host/i, `Compose ${name} must not use host networking`);
  }
}

function assertKubernetesApp(app: string) {
  forbidPattern(app, /^kind:\s*Secret\s*$/m, "Kubernetes example must not commit a Secret object");
  forbidPattern(app, /image:\s*\S+:latest\b/i, "Kubernetes example must not use latest image tags");
  requirePattern(
    app,
    /image:\s*ghcr\.io\/example\/gmao-maintenance-quality@sha256:0{64}/,
    "Kubernetes app image must remain an explicit replace-me digest placeholder",
  );
  requirePattern(app, /replicas:\s*1\b/, "local-storage Kubernetes example must default to one replica");
  requirePattern(app, /strategy:\s*[\s\S]{0,180}type:\s*Recreate/, "local-storage deployment must use Recreate");
  requirePattern(app, /automountServiceAccountToken:\s*false/, "Kubernetes pod must disable service-account token mounting");
  requirePattern(app, /runAsNonRoot:\s*true/, "Kubernetes pod must run as non-root");
  requirePattern(app, /runAsUser:\s*1001/, "Kubernetes pod must match the production image UID");
  requirePattern(app, /seccompProfile:\s*\n\s*type:\s*RuntimeDefault/, "Kubernetes pod must use RuntimeDefault seccomp");
  requirePattern(app, /allowPrivilegeEscalation:\s*false/, "Kubernetes app must disable privilege escalation");
  requirePattern(app, /capabilities:\s*\n\s*drop:\s*\n\s*- ALL/, "Kubernetes app must drop Linux capabilities");
  requirePattern(
    app,
    /secretKeyRef:\s*\n\s*name:\s*opengmao-runtime\s*\n\s*key:\s*DATABASE_URL/,
    "Kubernetes app must obtain DATABASE_URL from an external Secret",
  );
  requirePattern(app, /livenessProbe:[\s\S]{0,180}path:\s*\/api\/health/, "Kubernetes liveness must use /api/health");
  requirePattern(app, /readinessProbe:[\s\S]{0,180}path:\s*\/api\/ready/, "Kubernetes readiness must use /api/ready");
  requirePattern(
    app,
    /persistentVolumeClaim:\s*\n\s*claimName:\s*opengmao-documents/,
    "local-storage Kubernetes example must persist /app/data",
  );
  requirePattern(app, /kind:\s*Service[\s\S]*?type:\s*ClusterIP/, "Kubernetes service must remain internal by default");
}

function assertKubernetesMigration(migration: string) {
  forbidPattern(migration, /^kind:\s*Secret\s*$/m, "Kubernetes migration example must not commit a Secret object");
  forbidPattern(migration, /image:\s*\S+:latest\b/i, "Kubernetes migration example must not use latest image tags");
  requirePattern(migration, /kind:\s*Job/, "Kubernetes migrations must run as an explicit Job");
  requirePattern(
    migration,
    /image:\s*ghcr\.io\/example\/gmao-maintenance-quality-migrations@sha256:0{64}/,
    "Kubernetes migration image must remain an explicit replace-me digest placeholder",
  );
  requirePattern(
    migration,
    /\.\/node_modules\/\.bin\/prisma[\s\S]{0,120}- migrate[\s\S]{0,120}- deploy/,
    "Kubernetes migration job must use prisma migrate deploy",
  );
  requirePattern(
    migration,
    /secretKeyRef:\s*\n\s*name:\s*opengmao-runtime\s*\n\s*key:\s*DATABASE_URL/,
    "Kubernetes migration job must obtain DATABASE_URL from an external Secret",
  );
  requirePattern(migration, /automountServiceAccountToken:\s*false/, "Kubernetes migration job must disable service-account token mounting");
  requirePattern(migration, /runAsNonRoot:\s*true/, "Kubernetes migration job must run as non-root");
  requirePattern(migration, /runAsUser:\s*1001/, "Kubernetes migration job must use the migration image UID");
  requirePattern(migration, /readOnlyRootFilesystem:\s*true/, "Kubernetes migration job must use a read-only root filesystem");
  requirePattern(migration, /allowPrivilegeEscalation:\s*false/, "Kubernetes migration job must disable privilege escalation");
  requirePattern(migration, /capabilities:\s*\n\s*drop:\s*\n\s*- ALL/, "Kubernetes migration job must drop Linux capabilities");
}

export function assertDeploymentExamples(input: DeploymentExamples) {
  assertNoCommittedSecrets("Compose example", input.compose);
  assertNoCommittedSecrets("Kubernetes application example", input.kubernetesApp);
  assertNoCommittedSecrets("Kubernetes migration example", input.kubernetesMigration);
  assertDockerfile(input.dockerfile);
  assertCompose(input.compose);
  assertKubernetesApp(input.kubernetesApp);
  assertKubernetesMigration(input.kubernetesMigration);
}
