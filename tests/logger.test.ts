import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

const originalLogLevel = process.env.LOG_LEVEL;

function parseFirstCall(spy: ReturnType<typeof vi.spyOn>) {
  return JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
}

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
  });

  it("writes one-line structured JSON with stable core fields", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logger.info("work_order_created", { entityId: "demo-id", siteId: "site-a" });

    expect(spy).toHaveBeenCalledOnce();
    const raw = String(spy.mock.calls[0][0]);
    expect(raw).not.toContain("\n");

    const payload = JSON.parse(raw);
    expect(payload).toMatchObject({
      level: "info",
      service: "opengmao",
      environment: "test",
      message: "work_order_created",
      entityId: "demo-id",
      siteId: "site-a",
    });
    expect(payload.timestamp).toEqual(expect.any(String));
  });

  it("does not allow context to overwrite logger-owned fields", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logger.info("trusted_event", {
      timestamp: "attacker-time",
      level: "error",
      service: "different-service",
      environment: "different-environment",
      message: "different-message",
    });

    expect(parseFirstCall(spy)).toMatchObject({
      level: "info",
      service: "opengmao",
      environment: "test",
      message: "trusted_event",
    });
    expect(parseFirstCall(spy).timestamp).not.toBe("attacker-time");
  });

  it("redacts sensitive keys recursively", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logger.info("connector_request", {
      authorization: "Bearer top-secret",
      nested: {
        databaseUrl: "postgresql://user:password@db.internal/app",
        connector: {
          api_key: "gmao_sk_live_secret",
          refreshToken: "refresh-secret",
        },
      },
      safe: "kept",
    });

    const raw = String(spy.mock.calls[0][0]);
    expect(raw).not.toContain("top-secret");
    expect(raw).not.toContain("user:password");
    expect(raw).not.toContain("gmao_sk_live_secret");
    expect(raw).not.toContain("refresh-secret");

    const payload = JSON.parse(raw);
    expect(payload).toMatchObject({
      authorization: "[REDACTED]",
      nested: {
        databaseUrl: "[REDACTED]",
        connector: {
          api_key: "[REDACTED]",
          refreshToken: "[REDACTED]",
        },
      },
      safe: "kept",
    });
  });

  it("redacts compound production configuration secret keys", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logger.info("configuration_loaded", {
      STORAGE_S3_SECRET_ACCESS_KEY: "s3-secret-value",
      STORAGE_S3_ACCESS_KEY_ID: "s3-access-key-id",
      CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64: "connector-master-key",
      CONNECTOR_CREDENTIAL_PREVIOUS_MASTER_KEY_BASE64: "previous-master-key",
      OAUTH_CLIENT_SECRET_VALUE: "oauth-client-secret",
      nested: {
        upstreamAuthorizationHeader: "Bearer header-secret",
        sessionMetadata: "session-secret",
      },
      OIDC_CLIENT_ID: "public-client-id",
    });

    const raw = String(spy.mock.calls[0][0]);
    for (const secret of [
      "s3-secret-value",
      "s3-access-key-id",
      "connector-master-key",
      "previous-master-key",
      "oauth-client-secret",
      "header-secret",
      "session-secret",
    ]) {
      expect(raw).not.toContain(secret);
    }

    const payload = parseFirstCall(spy);
    expect(payload).toMatchObject({
      STORAGE_S3_SECRET_ACCESS_KEY: "[REDACTED]",
      STORAGE_S3_ACCESS_KEY_ID: "[REDACTED]",
      CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64: "[REDACTED]",
      CONNECTOR_CREDENTIAL_PREVIOUS_MASTER_KEY_BASE64: "[REDACTED]",
      OAUTH_CLIENT_SECRET_VALUE: "[REDACTED]",
      nested: {
        upstreamAuthorizationHeader: "[REDACTED]",
        sessionMetadata: "[REDACTED]",
      },
      OIDC_CLIENT_ID: "public-client-id",
    });
  });

  it("redacts secret-shaped values even when their field name is generic", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logger.warn(
      "upstream failed for postgresql://operator:db-password@db.internal/app?token=query-secret",
      {
        upstream: "https://user:http-password@example.test/path?access_token=access-secret&mode=read",
        credentialText: "Bearer bearer-secret",
        webhookText: "delivery whsec_supersecret",
        keyText: "key gmao_sk_supersecret",
        jwtText: "eyJabcdefghi.abcdefghijklmnop.qrstuvwxyz12345",
      },
    );

    const raw = String(spy.mock.calls[0][0]);
    for (const secret of [
      "db-password",
      "query-secret",
      "http-password",
      "access-secret",
      "bearer-secret",
      "whsec_supersecret",
      "gmao_sk_supersecret",
      "eyJabcdefghi.abcdefghijklmnop.qrstuvwxyz12345",
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain("[REDACTED]");
  });

  it("never serializes Error messages or stacks", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = Object.assign(
      new Error("connection failed for postgresql://user:raw-password@db.internal/app"),
      { code: "P1001" },
    );

    logger.error("database_operation_failed", { error, operation: "healthcheck" });

    const raw = String(spy.mock.calls[0][0]);
    expect(raw).not.toContain("raw-password");
    expect(raw).not.toContain("connection failed");
    expect(raw).not.toContain("stack");
    expect(parseFirstCall(spy)).toMatchObject({
      error: { name: "Error", code: "P1001" },
      operation: "healthcheck",
    });
  });

  it("handles circular and unsupported context without breaking the caller", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const circular: Record<string, unknown> = { id: "asset-1" };
    circular.self = circular;

    expect(() =>
      logger.info("circular_context", {
        circular,
        callback: () => undefined,
      }),
    ).not.toThrow();

    expect(parseFirstCall(spy)).toMatchObject({
      circular: { id: "asset-1", self: "[CIRCULAR]" },
      callback: "[UNSERIALIZABLE]",
    });
  });

  it("supports bounded child context for correlation fields", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const siteLogger = logger.child({
      component: "webhook-worker",
      organizationId: "org-a",
      siteId: "site-a",
      token: "must-not-leak",
    });

    siteLogger.info("delivery_completed", { deliveryId: "delivery-1" });

    expect(parseFirstCall(spy)).toMatchObject({
      component: "webhook-worker",
      organizationId: "org-a",
      siteId: "site-a",
      deliveryId: "delivery-1",
      token: "[REDACTED]",
    });
  });

  it("filters lower-severity entries according to LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logger.info("not_emitted");
    logger.warn("emitted");

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
