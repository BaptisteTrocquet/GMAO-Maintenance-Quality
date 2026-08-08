import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "@/lib/access-control";
import { AiAuditError } from "@/lib/ai/audit";
import { AssetContextAssistantError } from "@/lib/ai/asset-context-assistant";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  createServerAssetContextAssistant: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/ai/server-runtime", () => {
  class AiRuntimeConfigurationError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
      super(message);
      this.name = "AiRuntimeConfigurationError";
    }
  }

  return {
    AiRuntimeConfigurationError,
    createServerAssetContextAssistant: mocks.createServerAssetContextAssistant,
  };
});

import { AiRuntimeConfigurationError } from "@/lib/ai/server-runtime";
import { POST } from "@/app/api/ai/assets/[assetId]/ask/route";

const auth = {
  session: { user: { id: "user-1" } },
  tenant: {
    scope: {
      role: "TECHNICIAN",
      active: true,
      allSites: false,
      siteIds: ["site-a"],
    },
  },
};

const params = { params: Promise.resolve({ assetId: "asset-1" }) };

function request(body: unknown) {
  return new Request("http://localhost/api/ai/assets/asset-1/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function payload(response: Response) {
  return response.json() as Promise<{
    data?: unknown;
    error?: { code?: string; message?: string; details?: unknown };
  }>;
}

describe("Asset Context Assistant API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.createServerAssetContextAssistant.mockReturnValue({ ask: mocks.ask });
  });

  it("rejects client-side runtime controls before authentication or runtime composition", async () => {
    for (const forbidden of [
      { model: "expensive-model" },
      { providerId: "other" },
      { workOrderLimit: 20 },
    ]) {
      const response = await POST(
        request({ organizationId: "org-a", siteId: "site-a", question: "What changed?", ...forbidden }),
        params,
      );
      expect(response.status).toBe(400);
      expect((await payload(response)).error?.code).toBe("INVALID_PAYLOAD");
    }

    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.createServerAssetContextAssistant).not.toHaveBeenCalled();
  });

  it("returns authentication errors before the AI runtime can be composed", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      error: new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    });

    const response = await POST(
      request({ organizationId: "org-a", siteId: "site-a", question: "What changed?" }),
      params,
    );

    expect(response.status).toBe(401);
    expect(mocks.createServerAssetContextAssistant).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("passes authenticated tenant context and question to the resilient assistant", async () => {
    const generated = {
      status: "generated" as const,
      result: {
        answer: "The pump has two recent corrective interventions.",
        providerId: "openai",
        model: "operator-model",
        finishReason: "stop" as const,
        usage: { inputTokens: 32, outputTokens: 12 },
        asset: { id: "asset-1", code: "P-100", name: "Synthetic pump", siteId: "site-a" },
        sources: [
          { type: "asset" as const, id: "asset-1", code: "P-100", href: "/assets/asset-1" },
        ],
        citations: [
          { type: "asset" as const, recordId: "asset-1", revisionId: null, label: "Asset P-100" },
        ],
      },
    };
    mocks.ask.mockResolvedValue(generated);

    const response = await POST(
      request({ organizationId: "org-a", siteId: "site-a", question: "What changed recently?" }),
      params,
    );

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ data: generated });
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(expect.any(Request), "org-a");
    expect(mocks.createServerAssetContextAssistant).toHaveBeenCalledTimes(1);
    expect(mocks.ask).toHaveBeenCalledWith({
      authorization: {
        organizationId: "org-a",
        siteId: "site-a",
        actorId: "user-1",
        scope: auth.tenant.scope,
      },
      assetId: "asset-1",
      question: "What changed recently?",
    });
  });

  it("returns provider fallback as successful API data", async () => {
    const unavailable = {
      status: "unavailable" as const,
      reason: "AI_DISABLED" as const,
      retryable: false,
      message: "AI is disabled. Core maintenance data and workflows remain available.",
    };
    mocks.ask.mockResolvedValue(unavailable);

    const response = await POST(
      request({ organizationId: "org-a", siteId: "site-a", question: "Any risk?" }),
      params,
    );

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ data: unavailable });
  });

  it("maps authorization and asset-not-found errors without leaking diagnostics", async () => {
    mocks.ask.mockRejectedValueOnce(new AccessDeniedError("sensitive permission detail"));
    const denied = await POST(
      request({ organizationId: "org-a", siteId: "site-a", question: "Any risk?" }),
      params,
    );
    const deniedBody = await payload(denied);
    expect(denied.status).toBe(403);
    expect(deniedBody.error).toMatchObject({ code: "ACCESS_DENIED", message: "Access denied" });
    expect(JSON.stringify(deniedBody)).not.toContain("sensitive permission detail");

    mocks.ask.mockRejectedValueOnce(
      new AssetContextAssistantError("ASSET_NOT_FOUND", "tenant-scoped repository diagnostic"),
    );
    const missing = await POST(
      request({ organizationId: "org-a", siteId: "site-a", question: "Any risk?" }),
      params,
    );
    const missingBody = await payload(missing);
    expect(missing.status).toBe(404);
    expect(missingBody.error).toMatchObject({ code: "ASSET_NOT_FOUND", message: "Asset not found" });
    expect(JSON.stringify(missingBody)).not.toContain("tenant-scoped repository diagnostic");
  });

  it("fails closed for tenant/context and audit errors", async () => {
    mocks.ask.mockRejectedValueOnce(
      new AssetContextAssistantError("TENANT_SCOPE_MISMATCH", "cross-tenant diagnostic"),
    );
    const scoped = await POST(
      request({ organizationId: "org-a", siteId: "site-a", question: "Any risk?" }),
      params,
    );
    const scopedBody = await payload(scoped);
    expect(scoped.status).toBe(500);
    expect(scopedBody.error?.code).toBe("AI_CONTEXT_INVALID");
    expect(JSON.stringify(scopedBody)).not.toContain("cross-tenant diagnostic");

    mocks.ask.mockRejectedValueOnce(
      new AiAuditError("AUDIT_WRITE_FAILED", "database audit diagnostic"),
    );
    const audit = await POST(
      request({ organizationId: "org-a", siteId: "site-a", question: "Any risk?" }),
      params,
    );
    const auditBody = await payload(audit);
    expect(audit.status).toBe(500);
    expect(auditBody.error?.code).toBe("AI_AUDIT_FAILED");
    expect(JSON.stringify(auditBody)).not.toContain("database audit diagnostic");
  });

  it("returns a safe 503 for invalid deployment AI configuration", async () => {
    mocks.createServerAssetContextAssistant.mockImplementation(() => {
      throw new AiRuntimeConfigurationError("configuration secret diagnostic");
    });

    const response = await POST(
      request({ organizationId: "org-a", siteId: "site-a", question: "Any risk?" }),
      params,
    );
    const body = await payload(response);

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("AI_RUNTIME_MISCONFIGURED");
    expect(JSON.stringify(body)).not.toContain("configuration secret diagnostic");
  });

  it("redacts unexpected runtime failures", async () => {
    mocks.ask.mockRejectedValue(new Error("provider or database internal diagnostic"));

    const response = await POST(
      request({ organizationId: "org-a", siteId: "site-a", question: "Any risk?" }),
      params,
    );
    const body = await payload(response);

    expect(response.status).toBe(500);
    expect(body.error?.code).toBe("AI_ASSISTANT_FAILED");
    expect(JSON.stringify(body)).not.toContain("provider or database internal diagnostic");
  });
});
