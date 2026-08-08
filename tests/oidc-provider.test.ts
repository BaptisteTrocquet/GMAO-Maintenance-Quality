import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createOidcProviderFromEnv,
  IdentityProviderConfigurationError,
  OidcAuthenticationProvider,
} from "@/lib/auth/oidc-provider";

const NOW = new Date("2026-08-08T08:45:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function keyPair(kid = "key-1") {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

function token(
  pair: ReturnType<typeof keyPair>,
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: pair.kid, ...headerOverrides }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://identity.example.com/tenant-a/v2.0",
      aud: "gmao-client",
      sub: "external-subject-1",
      email: "Demo.User@Example.com",
      name: "Demo User",
      email_verified: true,
      iat: NOW_SECONDS - 30,
      exp: NOW_SECONDS + 300,
      ...payloadOverrides,
    }),
  ).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), pair.privateKey).toString(
    "base64url",
  );
  return `${header}.${payload}.${signature}`;
}

function provider(
  loadJwks: ReturnType<typeof vi.fn>,
  overrides: Partial<ConstructorParameters<typeof OidcAuthenticationProvider>[0]> = {},
) {
  return new OidcAuthenticationProvider(
    {
      id: "corporate-oidc",
      organizationId: "org-a",
      issuer: "https://identity.example.com/tenant-a/v2.0/",
      clientId: "gmao-client",
      jwksUri: "https://identity.example.com/tenant-a/discovery/v2.0/keys",
      ...overrides,
    },
    { now: () => NOW, loadJwks },
  );
}

describe("OIDC authentication provider", () => {
  it("verifies a signed tenant-scoped ID token and maps the external identity", async () => {
    const pair = keyPair();
    const loadJwks = vi.fn().mockResolvedValue({ keys: [pair.jwk] });
    const adapter = provider(loadJwks);

    await expect(
      adapter.verify({ organizationId: "org-a", idToken: token(pair) }),
    ).resolves.toEqual({
      provider: "corporate-oidc",
      subject: "external-subject-1",
      email: "Demo.User@Example.com",
      displayName: "Demo User",
    });
    expect(loadJwks).toHaveBeenCalledWith(
      "https://identity.example.com/tenant-a/discovery/v2.0/keys",
    );
  });

  it("rejects cross-organization verification before loading provider keys", async () => {
    const pair = keyPair();
    const loadJwks = vi.fn().mockResolvedValue({ keys: [pair.jwk] });
    const adapter = provider(loadJwks);

    await expect(
      adapter.verify({ organizationId: "org-b", idToken: token(pair) }),
    ).resolves.toBeNull();
    expect(loadJwks).not.toHaveBeenCalled();
  });

  it("rejects tokens for a different issuer or client audience", async () => {
    const pair = keyPair();
    const loadJwks = vi.fn().mockResolvedValue({ keys: [pair.jwk] });
    const adapter = provider(loadJwks);

    await expect(
      adapter.verify({
        organizationId: "org-a",
        idToken: token(pair, { iss: "https://evil.example.com" }),
      }),
    ).resolves.toBeNull();
    await expect(
      adapter.verify({
        organizationId: "org-a",
        idToken: token(pair, { aud: "different-client" }),
      }),
    ).resolves.toBeNull();
    expect(loadJwks).not.toHaveBeenCalled();
  });

  it("rejects expired, future and unsigned algorithm-confused tokens", async () => {
    const pair = keyPair();
    const loadJwks = vi.fn().mockResolvedValue({ keys: [pair.jwk] });
    const adapter = provider(loadJwks, { clockToleranceSeconds: 0 });

    await expect(
      adapter.verify({ organizationId: "org-a", idToken: token(pair, { exp: NOW_SECONDS - 1 }) }),
    ).resolves.toBeNull();
    await expect(
      adapter.verify({ organizationId: "org-a", idToken: token(pair, { nbf: NOW_SECONDS + 1 }) }),
    ).resolves.toBeNull();
    await expect(
      adapter.verify({
        organizationId: "org-a",
        idToken: token(pair, {}, { alg: "none" }),
      }),
    ).resolves.toBeNull();
    expect(loadJwks).not.toHaveBeenCalled();
  });

  it("rejects a token whose signature does not match the advertised key", async () => {
    const signer = keyPair("key-1");
    const other = keyPair("key-1");
    const loadJwks = vi.fn().mockResolvedValue({ keys: [other.jwk] });
    const adapter = provider(loadJwks);

    await expect(
      adapter.verify({ organizationId: "org-a", idToken: token(signer) }),
    ).resolves.toBeNull();
  });

  it("can require an explicitly verified email claim", async () => {
    const pair = keyPair();
    const loadJwks = vi.fn().mockResolvedValue({ keys: [pair.jwk] });
    const adapter = provider(loadJwks, { requireEmailVerified: true });

    await expect(
      adapter.verify({
        organizationId: "org-a",
        idToken: token(pair, { email_verified: false }),
      }),
    ).resolves.toBeNull();
    expect(loadJwks).not.toHaveBeenCalled();
  });

  it("supports claim mapping and uses a stable fallback display name", async () => {
    const pair = keyPair();
    const loadJwks = vi.fn().mockResolvedValue({ keys: [pair.jwk] });
    const adapter = provider(loadJwks, {
      emailClaim: "upn",
      displayNameClaims: ["display_name", "preferred_username"],
    });

    const result = await adapter.verify({
      organizationId: "org-a",
      idToken: token(pair, {
        email: undefined,
        name: undefined,
        upn: "technician@example.com",
        preferred_username: "Technician A",
      }),
    });

    expect(result).toMatchObject({
      email: "technician@example.com",
      displayName: "Technician A",
    });
  });

  it("caches JWKS and refreshes once when a rotated key id is missing", async () => {
    const oldPair = keyPair("old-key");
    const newPair = keyPair("new-key");
    const loadJwks = vi
      .fn()
      .mockResolvedValueOnce({ keys: [oldPair.jwk] })
      .mockResolvedValueOnce({ keys: [newPair.jwk] });
    const adapter = provider(loadJwks);

    await expect(
      adapter.verify({ organizationId: "org-a", idToken: token(oldPair) }),
    ).resolves.toMatchObject({ subject: "external-subject-1" });
    await expect(
      adapter.verify({ organizationId: "org-a", idToken: token(newPair) }),
    ).resolves.toMatchObject({ subject: "external-subject-1" });
    expect(loadJwks).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the JWKS loader throws without exposing provider details", async () => {
    const pair = keyPair();
    const loadJwks = vi.fn().mockRejectedValue(new Error("secret-provider-debug-token"));
    const adapter = provider(loadJwks);

    await expect(
      adapter.verify({ organizationId: "org-a", idToken: token(pair) }),
    ).resolves.toBeNull();
  });

  it("requires HTTPS provider endpoints and bounded clock/cache settings", () => {
    const loadJwks = vi.fn();
    expect(() =>
      provider(loadJwks, { issuer: "http://identity.example.com", jwksUri: "https://keys.example.com" }),
    ).toThrow(IdentityProviderConfigurationError);
    expect(() =>
      provider(loadJwks, { jwksUri: "http://identity.example.com/keys" }),
    ).toThrow(IdentityProviderConfigurationError);
    expect(() => provider(loadJwks, { clockToleranceSeconds: 301 })).toThrow(
      IdentityProviderConfigurationError,
    );
  });

  it("builds a tenant-scoped provider from deployment configuration", () => {
    const adapter = createOidcProviderFromEnv(
      {
        OIDC_PROVIDER_ID: "entra",
        OIDC_ORGANIZATION_ID: "org-a",
        OIDC_ISSUER: "https://login.example.com/tenant/v2.0",
        OIDC_CLIENT_ID: "client-a",
        OIDC_JWKS_URI: "https://login.example.com/tenant/keys",
        OIDC_EMAIL_CLAIM: "preferred_username",
        OIDC_DISPLAY_NAME_CLAIMS: "name,given_name",
        OIDC_REQUIRE_EMAIL_VERIFIED: "true",
      },
      { loadJwks: vi.fn() },
    );

    expect(adapter.id).toBe("entra");
  });
});
