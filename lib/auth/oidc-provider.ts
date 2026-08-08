import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import https from "node:https";
import { resolvePublicWebhookTarget } from "@/lib/webhooks/security";
import type { AuthenticationProvider, ExternalIdentity } from "@/lib/auth/provider";

export class IdentityProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityProviderConfigurationError";
  }
}

type OidcInput = {
  organizationId: string;
  idToken: string;
};

export type OidcProviderConfig = {
  id: string;
  organizationId: string;
  issuer: string;
  clientId: string;
  jwksUri: string;
  emailClaim?: string;
  displayNameClaims?: readonly string[];
  requireEmailVerified?: boolean;
  clockToleranceSeconds?: number;
  jwksCacheMs?: number;
};

type Jwk = JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
  kty?: string;
};

type JwksDocument = { keys: Jwk[] };

type OidcProviderOptions = {
  now?: () => Date;
  loadJwks?: (url: string) => Promise<JwksDocument>;
};

const DEFAULT_DISPLAY_NAME_CLAIMS = ["name", "preferred_username"] as const;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;
const DEFAULT_JWKS_CACHE_MS = 5 * 60 * 1000;
const JWKS_MAX_BYTES = 256 * 1024;
const JWKS_TIMEOUT_MS = 5_000;

function normalizeHttpsUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IdentityProviderConfigurationError(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:") {
    throw new IdentityProviderConfigurationError(`${label} must use HTTPS`);
  }
  if (url.username || url.password || url.hash) {
    throw new IdentityProviderConfigurationError(`${label} cannot contain credentials or fragments`);
  }
  return url;
}

function normalizeIssuer(value: string) {
  const url = normalizeHttpsUrl(value, "OIDC issuer");
  if (url.search) {
    throw new IdentityProviderConfigurationError("OIDC issuer cannot contain query parameters");
  }
  return url.toString().replace(/\/$/, "");
}

function validateConfig(config: OidcProviderConfig) {
  const id = config.id.trim().toLowerCase();
  const organizationId = config.organizationId.trim();
  const clientId = config.clientId.trim();
  const issuer = normalizeIssuer(config.issuer);
  const jwksUri = normalizeHttpsUrl(config.jwksUri, "OIDC JWKS URI").toString();
  const emailClaim = (config.emailClaim ?? "email").trim();
  const displayNameClaims = (config.displayNameClaims ?? DEFAULT_DISPLAY_NAME_CLAIMS)
    .map((claim) => claim.trim())
    .filter(Boolean);
  const clockToleranceSeconds = config.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  const jwksCacheMs = config.jwksCacheMs ?? DEFAULT_JWKS_CACHE_MS;

  if (!id || !organizationId || !clientId || !emailClaim || displayNameClaims.length === 0) {
    throw new IdentityProviderConfigurationError(
      "OIDC id, organizationId, clientId, email claim and display-name claims are required",
    );
  }
  if (
    !Number.isInteger(clockToleranceSeconds) ||
    clockToleranceSeconds < 0 ||
    clockToleranceSeconds > 300
  ) {
    throw new IdentityProviderConfigurationError(
      "OIDC clock tolerance must be an integer between 0 and 300 seconds",
    );
  }
  if (!Number.isInteger(jwksCacheMs) || jwksCacheMs < 0 || jwksCacheMs > 60 * 60 * 1000) {
    throw new IdentityProviderConfigurationError(
      "OIDC JWKS cache duration must be between 0 and 3600000 ms",
    );
  }

  return {
    id,
    organizationId,
    clientId,
    issuer,
    jwksUri,
    emailClaim,
    displayNameClaims,
    clockToleranceSeconds,
    jwksCacheMs,
    requireEmailVerified: config.requireEmailVerified ?? false,
  };
}

function parseSegment(segment: string): Record<string, unknown> | null {
  try {
    const decoded = Buffer.from(segment, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringClaim(payload: Record<string, unknown>, claim: string) {
  const value = payload[claim];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function audienceMatches(value: unknown, expected: string) {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((entry) => entry === expected);
}

function numericClaim(payload: Record<string, unknown>, claim: string) {
  const value = payload[claim];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isOidcInput(input: unknown): input is OidcInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    typeof value.organizationId === "string" &&
    value.organizationId.length > 0 &&
    typeof value.idToken === "string" &&
    value.idToken.length > 0
  );
}

async function fetchPublicJson(urlValue: string): Promise<JwksDocument> {
  const target = await resolvePublicWebhookTarget(urlValue);
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: "https:",
        hostname: target.address,
        family: target.family,
        port: target.url.port ? Number(target.url.port) : 443,
        path: `${target.url.pathname}${target.url.search}`,
        method: "GET",
        servername: target.url.hostname,
        headers: {
          host: target.url.host,
          accept: "application/json",
        },
        timeout: JWKS_TIMEOUT_MS,
      },
      (response) => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          response.resume();
          reject(new Error("OIDC JWKS request failed"));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > JWKS_MAX_BYTES) {
            request.destroy(new Error("OIDC JWKS response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as JwksDocument).keys)) {
              reject(new Error("OIDC JWKS response is invalid"));
              return;
            }
            resolve(parsed as JwksDocument);
          } catch {
            reject(new Error("OIDC JWKS response is invalid"));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("OIDC JWKS request timed out")));
    request.on("error", reject);
    request.end();
  });
}

export class OidcAuthenticationProvider implements AuthenticationProvider {
  readonly id: string;
  private readonly config: ReturnType<typeof validateConfig>;
  private readonly now: () => Date;
  private readonly loadJwks: (url: string) => Promise<JwksDocument>;
  private cache: { expiresAt: number; keys: Jwk[] } | null = null;

  constructor(config: OidcProviderConfig, options: OidcProviderOptions = {}) {
    this.config = validateConfig(config);
    this.id = this.config.id;
    this.now = options.now ?? (() => new Date());
    this.loadJwks = options.loadJwks ?? fetchPublicJson;
  }

  private async keys(forceRefresh = false) {
    const now = this.now().getTime();
    if (!forceRefresh && this.cache && this.cache.expiresAt > now) return this.cache.keys;
    const document = await this.loadJwks(this.config.jwksUri);
    const keys = document.keys.filter(
      (key) => key && key.kty === "RSA" && (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256"),
    );
    if (keys.length === 0) throw new Error("OIDC JWKS contains no supported signing keys");
    this.cache = { expiresAt: now + this.config.jwksCacheMs, keys };
    return keys;
  }

  private async signingKey(kid: string) {
    let key = (await this.keys()).find((candidate) => candidate.kid === kid);
    if (!key) {
      key = (await this.keys(true)).find((candidate) => candidate.kid === kid);
    }
    return key ?? null;
  }

  async verify(input: unknown): Promise<ExternalIdentity | null> {
    if (!isOidcInput(input) || input.organizationId !== this.config.organizationId) return null;

    try {
      const segments = input.idToken.split(".");
      if (segments.length !== 3 || segments.some((segment) => !segment)) return null;
      const [encodedHeader, encodedPayload, encodedSignature] = segments;
      const header = parseSegment(encodedHeader!);
      const payload = parseSegment(encodedPayload!);
      if (!header || !payload) return null;
      if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return null;

      const subject = stringClaim(payload, "sub");
      const email = stringClaim(payload, this.config.emailClaim);
      if (!subject || !email || !email.includes("@")) return null;
      if (payload.iss !== this.config.issuer || !audienceMatches(payload.aud, this.config.clientId)) {
        return null;
      }
      if (this.config.requireEmailVerified && payload.email_verified !== true) return null;

      const nowSeconds = Math.floor(this.now().getTime() / 1000);
      const tolerance = this.config.clockToleranceSeconds;
      const expiresAt = numericClaim(payload, "exp");
      const notBefore = numericClaim(payload, "nbf");
      const issuedAt = numericClaim(payload, "iat");
      if (expiresAt === null || expiresAt < nowSeconds - tolerance) return null;
      if (notBefore !== null && notBefore > nowSeconds + tolerance) return null;
      if (issuedAt !== null && issuedAt > nowSeconds + tolerance) return null;

      const jwk = await this.signingKey(header.kid);
      if (!jwk) return null;
      const key = createPublicKey({ key: jwk, format: "jwk" });
      const validSignature = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        key,
        Buffer.from(encodedSignature!, "base64url"),
      );
      if (!validSignature) return null;

      const displayName =
        this.config.displayNameClaims
          .map((claim) => stringClaim(payload, claim))
          .find((value): value is string => Boolean(value)) ?? email;

      return {
        provider: this.id,
        subject,
        email,
        displayName,
      };
    } catch {
      return null;
    }
  }
}

export function createOidcProviderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: OidcProviderOptions = {},
) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new IdentityProviderConfigurationError(`${name} is required`);
    return value;
  };

  return new OidcAuthenticationProvider(
    {
      id: env.OIDC_PROVIDER_ID?.trim() || "oidc",
      organizationId: required("OIDC_ORGANIZATION_ID"),
      issuer: required("OIDC_ISSUER"),
      clientId: required("OIDC_CLIENT_ID"),
      jwksUri: required("OIDC_JWKS_URI"),
      emailClaim: env.OIDC_EMAIL_CLAIM?.trim() || undefined,
      displayNameClaims: env.OIDC_DISPLAY_NAME_CLAIMS?.split(",").map((value) => value.trim()),
      requireEmailVerified: env.OIDC_REQUIRE_EMAIL_VERIFIED?.trim().toLowerCase() === "true",
    },
    options,
  );
}
