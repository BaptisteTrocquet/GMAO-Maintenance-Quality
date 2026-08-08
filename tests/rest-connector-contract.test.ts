import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  transport: vi.fn(),
}));

vi.mock("@/lib/webhooks/security", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/webhooks/security")>();
  return { ...original, resolvePublicWebhookTarget: mocks.resolveTarget };
});

import {
  createRestConnector,
  RestConnectorError,
  type RestConnectorTransport,
} from "@/lib/integrations/rest-connector";

const transport = mocks.transport as unknown as RestConnectorTransport;

function connector() {
  return createRestConnector(
    {
      id: "erp-primary",
      organizationId: "org-a",
      name: "Primary ERP",
      baseUrl: "https://erp.example.test/api/v1",
      defaultHeaders: { "X-Client": "OpenGMAO" },
    },
    { transport },
  );
}

const context = {
  organizationId: "org-a",
  siteId: "site-a",
  correlationId: "corr-123",
};

const noCredential = { kind: "none", organizationId: "org-a" } as const;

describe("generic REST connector contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockImplementation(async (value: string) => ({
      url: new URL(value),
      address: "8.8.8.8",
      family: 4 as const,
    }));
    mocks.transport.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "remote-1" },
      body: JSON.stringify({ ok: true }),
    });
  });

  it("executes a tenant-scoped relative request through the transport contract", async () => {
    const result = await connector().execute<{ ok: boolean }>({
      context,
      credential: { kind: "bearer", organizationId: "org-a", token: "top-secret-token" },
      request: {
        method: "POST",
        path: "work-orders",
        query: { source: "opengmao", page: 2, dryRun: false },
        body: { number: "WO-100" },
        headers: { "X-Operation": "create" },
      },
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "remote-1" },
      data: { ok: true },
    });
    expect(mocks.resolveTarget).toHaveBeenCalledWith(
      "https://erp.example.test/api/v1/work-orders?source=opengmao&page=2&dryRun=false",
    );
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({
      address: "8.8.8.8",
      family: 4,
      method: "POST",
      body: JSON.stringify({ number: "WO-100" }),
      headers: expect.objectContaining({
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Client": "OpenGMAO",
        "X-Operation": "create",
        Authorization: "Bearer top-secret-token",
        "X-OpenGMAO-Correlation-Id": "corr-123",
      }),
    }));
  });

  it("rejects cross-tenant execution before resolving or sending a request", async () => {
    await expect(
      connector().execute({
        context: { organizationId: "org-b" },
        credential: { kind: "bearer", organizationId: "org-a", token: "secret-a" },
        request: { method: "GET", path: "assets" },
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });

    await expect(
      connector().execute({
        context,
        credential: { kind: "bearer", organizationId: "org-b", token: "secret-b" },
        request: { method: "GET", path: "assets" },
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });

    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it("forces sensitive request headers through the runtime credential contract", async () => {
    expect(() =>
      createRestConnector({
        id: "bad",
        organizationId: "org-a",
        name: "Bad connector",
        baseUrl: "https://erp.example.test/api/",
        defaultHeaders: { Authorization: "Bearer persisted-secret" },
      }),
    ).toThrowError(RestConnectorError);

    await expect(
      connector().execute({
        context,
        credential: noCredential,
        request: {
          method: "GET",
          path: "assets",
          headers: { "X-API-Key": "persisted-secret" },
        },
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_HEADER" });

    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it("cannot escape the configured origin or base path", async () => {
    await expect(
      connector().execute({
        context,
        credential: noCredential,
        request: { method: "GET", path: "https://evil.example.test/steal" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await expect(
      connector().execute({
        context,
        credential: noCredential,
        request: { method: "GET", path: "../admin" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it("does not expose runtime secrets when the transport fails", async () => {
    mocks.transport.mockRejectedValueOnce(new Error("remote failure mentions top-secret-token"));

    let caught: unknown;
    try {
      await connector().execute({
        context,
        credential: { kind: "bearer", organizationId: "org-a", token: "top-secret-token" },
        request: { method: "GET", path: "assets" },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RestConnectorError);
    expect(caught).toMatchObject({ code: "NETWORK_ERROR" });
    expect(String(caught)).not.toContain("top-secret-token");
  });

  it("filters sensitive response headers and supports API-key credentials", async () => {
    mocks.transport.mockResolvedValueOnce({
      status: 204,
      headers: {
        "content-type": "application/json",
        "set-cookie": ["session=remote-secret"],
        "retry-after": "30",
      },
      body: "",
    });

    const result = await connector().execute({
      context,
      credential: {
        kind: "apiKey",
        organizationId: "org-a",
        headerName: "X-Vendor-Token",
        value: "vendor-secret",
      },
      request: { method: "DELETE", path: "work-orders/WO-100" },
    });

    expect(result).toEqual({
      ok: true,
      status: 204,
      headers: { "content-type": "application/json", "retry-after": "30" },
      data: null,
    });
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ "X-Vendor-Token": "vendor-secret" }),
    }));
  });

  it("maps unsafe DNS targets to a connector-safe error without leaking the URL", async () => {
    const original = await import("@/lib/webhooks/security");
    mocks.resolveTarget.mockRejectedValueOnce(
      new original.WebhookTargetError("Webhook hostname must resolve exclusively to public IP addresses"),
    );

    let caught: unknown;
    try {
      await connector().execute({
        context,
        credential: noCredential,
        request: { method: "GET", path: "assets", query: { token: "query-secret" } },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "UNSAFE_TARGET" });
    expect(String(caught)).not.toContain("query-secret");
    expect(mocks.transport).not.toHaveBeenCalled();
  });
});
