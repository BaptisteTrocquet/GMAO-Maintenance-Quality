import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "@/lib/access-control";
import { AiAuditError } from "@/lib/ai/audit";
import { WorkOrderSummarizationError } from "@/lib/ai/work-order-summarization";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  createServerWorkOrderSummarizer: vi.fn(),
  summarize: vi.fn(),
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
    createServerWorkOrderSummarizer: mocks.createServerWorkOrderSummarizer,
  };
});

import { AiRuntimeConfigurationError } from "@/lib/ai/server-runtime";
import { POST } from "@/app/api/ai/work-orders/[workOrderId]/summary/route";

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

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

function request(body: unknown) {
  return new Request("http://localhost/api/ai/work-orders/wo-1/summary", {
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

describe("Work Order AI summary API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.createServerWorkOrderSummarizer.mockReturnValue({ summarize: mocks.summarize });
  });

  it("rejects client-side model selection before authentication or runtime composition", async () => {
    const response = await POST(
      request({ organizationId: "org-a", siteId: "site-a", model: "expensive-model" }),
      params,
    );

    expect(response.status).toBe(400);
    expect((await payload(response)).error?.code).toBe("INVALID_PAYLOAD");
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.createServerWorkOrderSummarizer).not.toHaveBeenCalled();
  });

  it("returns authentication errors before the AI runtime can be composed", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      error: new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    });

    const response = await POST(request({ organizationId: "org-a", siteId: "site-a" }), params);

    expect(response.status).toBe(401);
    expect(mocks.createServerWorkOrderSummarizer).not.toHaveBeenCalled();
    expect(mocks.summarize).not.toHaveBeenCalled();
  });

  it("passes authenticated tenant context to the resilient summarizer and returns cited output", async () => {
    const generated = {
      status: "generated" as const,
      result: {
        summary: "Pump inspection is planned.",
        providerId: "openai",
        model: "operator-model",
        finishReason: "stop" as const,
        usage: { inputTokens: 20, outputTokens: 8 },
        workOrder: { id: "wo-1", number: "WO-1001", siteId: "site-a", status: "PLANNED" },
        sources: [
          { type: "work-order" as const, id: "wo-1", number: "WO-1001", href: "/maintenance/wo-1" },
        ],
      },
    };
    mocks.summarize.mockResolvedValue(generated);

    const response = await POST(request({ organizationId: "org-a", siteId: "site-a" }), params);

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ data: generated });
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(expect.any(Request), "org-a");
    expect(mocks.createServerWorkOrderSummarizer).toHaveBeenCalledTimes(1);
    expect(mocks.summarize).toHaveBeenCalledWith({
      authorization: {
        organizationId: "org-a",
        siteId: "site-a",
        actorId: "user-1",
        scope: auth.tenant.scope,
      },
      workOrderId: "wo-1",
    });
  });

  it("returns the normal unavailable state as successful API data when AI is disabled", async () => {
    const unavailable = {
      status: "unavailable" as const,
      reason: "AI_DISABLED" as const,
      retryable: false,
      message: "AI is disabled. Core maintenance data and workflows remain available.",
    };
    mocks.summarize.mockResolvedValue(unavailable);

    const response = await POST(request({ organizationId: "org-a", siteId: "site-a" }), params);

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ data: unavailable });
  });

  it("maps authorization and not-found errors without exposing internal details", async () => {
    mocks.summarize.mockRejectedValueOnce(new AccessDeniedError("sensitive site detail"));
    const denied = await POST(request({ organizationId: "org-a", siteId: "site-a" }), params);
    const deniedPayload = await payload(denied);
    expect(denied.status).toBe(403);
    expect(deniedPayload.error).toMatchObject({ code: "ACCESS_DENIED", message: "Access denied" });
    expect(JSON.stringify(deniedPayload)).not.toContain("sensitive site detail");

    mocks.summarize.mockRejectedValueOnce(
      new WorkOrderSummarizationError("WORK_ORDER_NOT_FOUND", "tenant-scoped lookup detail"),
    );
    const missing = await POST(request({ organizationId: "org-a", siteId: "site-a" }), params);
    const missingPayload = await payload(missing);
    expect(missing.status).toBe(404);
    expect(missingPayload.error).toMatchObject({ code: "WORK_ORDER_NOT_FOUND", message: "Work Order not found" });
    expect(JSON.stringify(missingPayload)).not.toContain("tenant-scoped lookup detail");
  });

  it("fails closed for tenant/context and audit errors instead of converting them to provider fallback", async () => {
    mocks.summarize.mockRejectedValueOnce(
      new WorkOrderSummarizationError("TENANT_SCOPE_MISMATCH", "cross-tenant diagnostic"),
    );
    const scoped = await POST(request({ organizationId: "org-a", siteId: "site-a" }), params);
    const scopedPayload = await payload(scoped);
    expect(scoped.status).toBe(500);
    expect(scopedPayload.error?.code).toBe("AI_CONTEXT_INVALID");
    expect(JSON.stringify(scopedPayload)).not.toContain("cross-tenant diagnostic");

    mocks.summarize.mockRejectedValueOnce(
      new AiAuditError("AUDIT_WRITE_FAILED", "database audit diagnostic"),
    );
    const audit = await POST(request({ organizationId: "org-a", siteId: "site-a" }), params);
    const auditPayload = await payload(audit);
    expect(audit.status).toBe(500);
    expect(auditPayload.error?.code).toBe("AI_AUDIT_FAILED");
    expect(JSON.stringify(auditPayload)).not.toContain("database audit diagnostic");
  });

  it("returns a safe 503 when deployment AI configuration is invalid", async () => {
    mocks.createServerWorkOrderSummarizer.mockImplementation(() => {
      throw new AiRuntimeConfigurationError("configuration includes secret diagnostic");
    });

    const response = await POST(request({ organizationId: "org-a", siteId: "site-a" }), params);
    const body = await payload(response);

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("AI_RUNTIME_MISCONFIGURED");
    expect(JSON.stringify(body)).not.toContain("secret diagnostic");
  });

  it("redacts unexpected runtime failures", async () => {
    mocks.summarize.mockRejectedValue(new Error("provider or database internal diagnostic"));

    const response = await POST(request({ organizationId: "org-a", siteId: "site-a" }), params);
    const body = await payload(response);

    expect(response.status).toBe(500);
    expect(body.error?.code).toBe("AI_SUMMARY_FAILED");
    expect(JSON.stringify(body)).not.toContain("provider or database internal diagnostic");
  });
});
