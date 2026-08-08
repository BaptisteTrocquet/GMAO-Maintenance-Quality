import { describe, expect, it } from "vitest";
import {
  assertProductionHardening,
  validateProductionHardening,
  type ProductionHardeningInputs,
} from "@/lib/production-hardening";

function compliant(): ProductionHardeningInputs {
  return {
    dockerfile: `
FROM node:22-bookworm-slim AS base
FROM base AS builder
ENV NODE_ENV=production
FROM base AS runner
ENV NODE_ENV=production \\
    STORAGE_LOCAL_DIR=/app/data/documents
USER nextjs
VOLUME ["/app/data"]
CMD ["node", "server.js"]
`,
    dockerignore: `.env\n.env.*\ndata\nbackups\n*.key\n*.pem\n.npmrc\n`,
    envExample: `DATABASE_URL="postgresql://opengmao:opengmao@localhost:5432/opengmao"\nSTORAGE_S3_SECRET_ACCESS_KEY=""\nCONNECTOR_CREDENTIAL_MASTER_KEY_BASE64=""\n`,
    rateLimitSource: `
trustedProxyHops: parseInteger(env.RATE_LIMIT_TRUST_PROXY_HOPS, 0, 0, 10),
return "ip:unidentified";
`,
    nextConfig: `const nextConfig = { output: "standalone" };`,
    ciWorkflow: `
permissions:
  contents: read
steps:
  - name: Scan production image
    uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
    with:
      image-ref: gmao-maintenance-quality:ci
      exit-code: "1"
      severity: "CRITICAL"
      version: "v0.73.0"
`,
  };
}

describe("production hardening policy", () => {
  it("accepts the documented hardened repository posture", () => {
    expect(validateProductionHardening(compliant())).toEqual([]);
    expect(() => assertProductionHardening(compliant())).not.toThrow();
  });

  it("rejects a root runtime or missing persistence boundary", () => {
    const input = compliant();
    input.dockerfile = input.dockerfile
      .replace("USER nextjs", "USER root")
      .replace('VOLUME ["/app/data"]', "");

    expect(validateProductionHardening(input)).toEqual(
      expect.arrayContaining([
        "production container must run as USER nextjs",
        "production container must declare /app/data as the persistence boundary",
      ]),
    );
  });

  it("rejects secret-bearing Docker build inputs and example values", () => {
    const input = compliant();
    input.dockerfile = input.dockerfile.replace(
      "FROM base AS builder",
      "FROM base AS builder\nARG API_TOKEN",
    );
    input.envExample += 'CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64="not-a-real-key-but-still-forbidden"\n';

    const violations = validateProductionHardening(input);
    expect(violations).toContain("Dockerfile must not accept secret-like build arguments");
    expect(violations).toContain(
      ".env.example must not contain a value for secret-like variable CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64",
    );
  });

  it("requires sensitive local material to stay outside the Docker build context", () => {
    const input = compliant();
    input.dockerignore = input.dockerignore.replace("backups\n", "").replace("*.key\n", "");

    expect(validateProductionHardening(input)).toEqual(
      expect.arrayContaining([
        ".dockerignore must exclude backups",
        ".dockerignore must exclude *.key",
      ]),
    );
  });

  it("rejects trusting forwarded addresses by default or broad CI permissions", () => {
    const input = compliant();
    input.rateLimitSource = input.rateLimitSource.replace(
      "RATE_LIMIT_TRUST_PROXY_HOPS, 0,",
      "RATE_LIMIT_TRUST_PROXY_HOPS, 1,",
    );
    input.ciWorkflow = input.ciWorkflow.replace("permissions:\n  contents: read", "permissions: write-all");

    expect(validateProductionHardening(input)).toEqual(
      expect.arrayContaining([
        "rate limiting must default to trusting zero proxy hops",
        "CI workflow must keep repository contents permission read-only",
      ]),
    );
  });

  it("requires an immutable Trivy action and scanner version that fail on critical findings", () => {
    const input = compliant();
    input.ciWorkflow = input.ciWorkflow
      .replace(
        "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25",
        "aquasecurity/trivy-action@v0.36.0",
      )
      .replace('exit-code: "1"', 'exit-code: "0"')
      .replace('severity: "CRITICAL"', 'severity: "HIGH"')
      .replace('version: "v0.73.0"', 'version: "latest"');

    expect(validateProductionHardening(input)).toEqual(
      expect.arrayContaining([
        "CI must pin the Trivy action to the approved immutable commit",
        "CI must pin Trivy scanner version v0.73.0",
        "CI vulnerability scan must include CRITICAL severity",
        "CI vulnerability scan must fail on matching vulnerabilities",
      ]),
    );
  });
});
