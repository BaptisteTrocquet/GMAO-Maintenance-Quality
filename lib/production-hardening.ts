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

  return violations;
}

export function assertProductionHardening(input: ProductionHardeningInputs) {
  const violations = validateProductionHardening(input);
  if (violations.length > 0) {
    throw new Error(`Production hardening policy failed:\n- ${violations.join("\n- ")}`);
  }
}
