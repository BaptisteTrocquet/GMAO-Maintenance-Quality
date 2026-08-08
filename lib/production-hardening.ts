export type ProductionHardeningInputs = {
  dockerfile: string;
  dockerignore: string;
  envExample: string;
  rateLimitSource: string;
  nextConfig: string;
  ciWorkflow: string;
};

const SECRET_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSWD|MASTER_KEY|PRIVATE_KEY|ACCESS_KEY)/i;
const SECRET_DOCKER_ARG_PATTERN = /^\s*ARG\s+[^\n]*(SECRET|TOKEN|PASSWORD|PASSWD|MASTER_KEY|PRIVATE_KEY|ACCESS_KEY)/im;
const SECRET_DOCKER_ENV_PATTERN = /^\s*ENV\s+[^\n]*(SECRET|TOKEN|PASSWORD|PASSWD|MASTER_KEY|PRIVATE_KEY|ACCESS_KEY)\s*=\s*[^\s\\]+/im;
const PINNED_TRIVY_ACTION = "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25";
const PINNED_TRIVY_VERSION = "v0.73.0";

function normalizedLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function hasIgnoreRule(dockerignore: string, required: string) {
  return normalizedLines(dockerignore).includes(required);
}

function validateSecretExamples(envExample: string, violations: string[]) {
  for (const rawLine of envExample.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!SECRET_KEY_PATTERN.test(key)) continue;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
    if (value) {
      violations.push(`.env.example must not contain a value for secret-like variable ${key}`);
    }
  }
}

function validateContainerScan(ciWorkflow: string, violations: string[]) {
  if (!ciWorkflow.includes(`uses: ${PINNED_TRIVY_ACTION}`)) {
    violations.push("CI must pin the Trivy action to the approved immutable commit");
  }
  if (!new RegExp(`version:\\s*["']?${PINNED_TRIVY_VERSION.replaceAll(".", "\\.")}["']?`).test(ciWorkflow)) {
    violations.push(`CI must pin Trivy scanner version ${PINNED_TRIVY_VERSION}`);
  }
  if (!/image-ref:\s*gmao-maintenance-quality:ci/.test(ciWorkflow)) {
    violations.push("CI must scan the production image that it just built");
  }
  if (!/severity:\s*["']?CRITICAL["']?/.test(ciWorkflow)) {
    violations.push("CI vulnerability scan must include CRITICAL severity");
  }
  if (!/exit-code:\s*["']1["']/.test(ciWorkflow)) {
    violations.push("CI vulnerability scan must fail on matching vulnerabilities");
  }
}

function removesRuntimePath(runnerSection: string, path: string) {
  const normalized = runnerSection.replace(/\\\r?\n\s*/g, " ");
  return normalized
    .split(/\r?\n/)
    .some((line) => /\brm\s+-rf\b/.test(line) && line.includes(path));
}

export function validateProductionHardening(input: ProductionHardeningInputs) {
  const violations: string[] = [];
  const runnerSection = input.dockerfile.split(/\nFROM\s+base\s+AS\s+runner\s*\n/i)[1] ?? "";

  if (!runnerSection) {
    violations.push("Dockerfile must contain the production runner stage");
  } else {
    if (!/^\s*USER\s+nextjs\s*$/im.test(runnerSection)) {
      violations.push("production container must run as USER nextjs");
    }
    if (!/NODE_ENV=production/.test(runnerSection)) {
      violations.push("production container must set NODE_ENV=production");
    }
    if (!/STORAGE_LOCAL_DIR=\/app\/data\/documents/.test(runnerSection)) {
      violations.push("production local storage must use /app/data/documents");
    }
    if (!/VOLUME\s*\[\s*"\/app\/data"\s*\]/.test(runnerSection)) {
      violations.push("production container must declare /app/data as the persistence boundary");
    }
    if (!removesRuntimePath(runnerSection, "/usr/local/lib/node_modules/npm")) {
      violations.push("production runtime must remove the global npm package manager after build");
    }
    if (!removesRuntimePath(runnerSection, "/opt/yarn-v*")) {
      violations.push("production runtime must remove bundled Yarn after build");
    }
  }

  if (SECRET_DOCKER_ARG_PATTERN.test(input.dockerfile)) {
    violations.push("Dockerfile must not accept secret-like build arguments");
  }
  if (SECRET_DOCKER_ENV_PATTERN.test(input.dockerfile)) {
    violations.push("Dockerfile must not bake secret-like environment values into image layers");
  }

  for (const required of [".env", ".env.*", "data", "backups", "*.key", "*.pem", ".npmrc"]) {
    if (!hasIgnoreRule(input.dockerignore, required)) {
      violations.push(`.dockerignore must exclude ${required}`);
    }
  }

  validateSecretExamples(input.envExample, violations);

  if (!/trustedProxyHops:\s*parseInteger\(env\.RATE_LIMIT_TRUST_PROXY_HOPS,\s*0,/.test(input.rateLimitSource)) {
    violations.push("rate limiting must default to trusting zero proxy hops");
  }
  if (!/return\s+"ip:unidentified"/.test(input.rateLimitSource)) {
    violations.push("rate limiting must fail safe when no trusted client address is available");
  }

  if (!/output:\s*["']standalone["']/.test(input.nextConfig)) {
    violations.push("Next.js production output must remain standalone");
  }

  if (!/permissions:\s*\n\s+contents:\s+read/.test(input.ciWorkflow)) {
    violations.push("CI workflow must keep repository contents permission read-only");
  }
  validateContainerScan(input.ciWorkflow, violations);

  return violations;
}

export function assertProductionHardening(input: ProductionHardeningInputs) {
  const violations = validateProductionHardening(input);
  if (violations.length > 0) {
    throw new Error(`Production hardening policy failed:\n- ${violations.join("\n- ")}`);
  }
}
