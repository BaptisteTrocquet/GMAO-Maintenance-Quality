type DeploymentExamples = {
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

function assertCompose(compose: string) {
  requirePattern(
    compose,
    /POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:\?/,
    "Compose must require POSTGRES_PASSWORD from the external runtime environment",
  );
  requirePattern(
    compose,
    /DATABASE_URL:\s*\$\{DATABASE_URL:\?/,
    "Compose must require DATABASE_URL from the external runtime environment",
  );
  requirePattern(
    compose,
    /OPENGMAO_BIND_ADDRESS:-127\.0\.0\.1/,
    "Compose must bind to loopback by default instead of all host interfaces",
  );
  requirePattern(
    compose,
    /RATE_LIMIT_ENABLED:\s*\$\{RATE_LIMIT_ENABLED:-true\}/,
    "Compose must keep application rate limiting enabled by default",
  );
  requirePattern(
    compose,
    /profiles:\s*\["migrate"\]/,
    "Compose migration execution must remain an explicit profile",
  );
  requirePattern(
    compose,
    /command:\s*\["npm",\s*"run",\s*"prisma:deploy"\]/,
    "Compose migration service must use the committed prisma:deploy workflow",
  );
  requirePattern(
    compose,
    /opengmao_documents:\/app\/data/,
    "Compose must persist local controlled-document storage",
  );
  requirePattern(
    compose,
    /no-new-privileges:true/,
    "Compose services must use no-new-privileges",
  );
  requirePattern(compose, /cap_drop:\s*\n\s*- ALL/, "Compose services must drop Linux capabilities");

  forbidPattern(compose, /privileged:\s*true/i, "Compose must never run privileged containers");
  forbidPattern(compose, /network_mode:\s*host/i, "Compose must not use host networking");
  forbidPattern(
    compose,
    /db:[\s\S]*?ports:\s*\n\s*-\s*["']?\d+:/,
    "Compose must not publish PostgreSQL on the host",
  );
}

function assertKubernetesApp(app: string) {
  forbidPattern(app, /^kind:\s*Secret\s*$/m, "Kubernetes example must not commit a Secret object");
  forbidPattern(app, /image:\s*\S+:latest\b/i, "Kubernetes example must not use latest image tags");
  requirePattern(
    app,
    /image:\s*ghcr\.io\/example\/gmao-maintenance-quality:REPLACE_WITH_RELEASE/,
    "Kubernetes app image must remain an explicit replace-me release placeholder",
  );
  requirePattern(app, /replicas:\s*1\b/, "local-storage Kubernetes example must default to one replica");
  requirePattern(app, /strategy:\s*\n\s*type:\s*Recreate/, "local-storage deployment must use Recreate");
  requirePattern(app, /automountServiceAccountToken:\s*false/, "Kubernetes pod must disable service-account token mounting");
  requirePattern(app, /runAsNonRoot:\s*true/, "Kubernetes pod must run as non-root");
  requirePattern(app, /runAsUser:\s*1001/, "Kubernetes pod must match the production image UID");
  requirePattern(app, /allowPrivilegeEscalation:\s*false/, "Kubernetes app must disable privilege escalation");
  requirePattern(app, /capabilities:\s*\n\s*drop:\s*\n\s*- ALL/, "Kubernetes app must drop Linux capabilities");
  requirePattern(app, /secretKeyRef:\s*\n\s*name:\s*opengmao-runtime\s*\n\s*key:\s*DATABASE_URL/, "Kubernetes app must obtain DATABASE_URL from an external Secret");
  requirePattern(app, /livenessProbe:[\s\S]{0,180}path:\s*\/api\/health/, "Kubernetes liveness must use /api/health");
  requirePattern(app, /readinessProbe:[\s\S]{0,180}path:\s*\/api\/ready/, "Kubernetes readiness must use /api/ready");
  requirePattern(app, /persistentVolumeClaim:\s*\n\s*claimName:\s*opengmao-documents/, "local-storage Kubernetes example must persist /app/data");
  requirePattern(app, /kind:\s*Service[\s\S]*?type:\s*ClusterIP/, "Kubernetes service must remain internal by default");
}

function assertKubernetesMigration(migration: string) {
  forbidPattern(migration, /^kind:\s*Secret\s*$/m, "Kubernetes migration example must not commit a Secret object");
  forbidPattern(migration, /image:\s*\S+:latest\b/i, "Kubernetes migration example must not use latest image tags");
  requirePattern(migration, /kind:\s*Job/, "Kubernetes migrations must run as an explicit Job");
  requirePattern(
    migration,
    /image:\s*ghcr\.io\/example\/gmao-maintenance-quality-migrations:REPLACE_WITH_RELEASE/,
    "Kubernetes migration image must remain an explicit replace-me release placeholder",
  );
  requirePattern(
    migration,
    /\.\/node_modules\/\.bin\/prisma[\s\S]{0,120}- migrate[\s\S]{0,120}- deploy/,
    "Kubernetes migration job must use prisma migrate deploy",
  );
  requirePattern(migration, /secretKeyRef:\s*\n\s*name:\s*opengmao-runtime\s*\n\s*key:\s*DATABASE_URL/, "Kubernetes migration job must obtain DATABASE_URL from an external Secret");
  requirePattern(migration, /automountServiceAccountToken:\s*false/, "Kubernetes migration job must disable service-account token mounting");
  requirePattern(migration, /runAsNonRoot:\s*true/, "Kubernetes migration job must run as non-root");
  requirePattern(migration, /readOnlyRootFilesystem:\s*true/, "Kubernetes migration job must use a read-only root filesystem");
  requirePattern(migration, /allowPrivilegeEscalation:\s*false/, "Kubernetes migration job must disable privilege escalation");
  requirePattern(migration, /capabilities:\s*\n\s*drop:\s*\n\s*- ALL/, "Kubernetes migration job must drop Linux capabilities");
}

export function assertDeploymentExamples(input: DeploymentExamples) {
  assertNoCommittedSecrets("Compose example", input.compose);
  assertNoCommittedSecrets("Kubernetes application example", input.kubernetesApp);
  assertNoCommittedSecrets("Kubernetes migration example", input.kubernetesMigration);
  assertCompose(input.compose);
  assertKubernetesApp(input.kubernetesApp);
  assertKubernetesMigration(input.kubernetesMigration);
}
