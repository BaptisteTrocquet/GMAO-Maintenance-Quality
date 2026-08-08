import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "@/lib/access-control";
import { ControlledDocumentSearchError } from "@/lib/ai/controlled-document-search";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  createServerControlledDocumentSemanticSearch: vi.fn(),
  search: vi.fn(),
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
    createServerControlledDocumentSemanticSearch: mocks.createServerControlledDocumentSemanticSearch,
  };
});

import { AiRuntimeConfigurationError } from "@/lib/ai/server-runtime";
import { POST } from "@/app/api/ai/documents/search/route";

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

function request(body: unknown) {
  return new Request("http://localhost/api/ai/documents/search", {
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

describe("controlled-document semantic search API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.createServerControlledDocumentSemanticSearch.mockReturnValue({ search: mocks.search });
  });

  it("rejects client-side embedding/runtime controls before authentication or runtime composition", async () => {
    for (const forbidden of [
      { embeddingProviderId: "other" },
      { embeddingModel: "expensive-model" },
      { dimensions: 9_999 },
      { namespace: "another-org" },
    ]) {
      const response = await POST(
        request({ organizationId: "org-a", query: "pump maintenance", ...forbidden }),
      );
      expect(response.status).toBe(400);
      expect((await payload(response)).error?.code).toBe("INVALID_PAYLOAD");
    }

    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.createServerControlledDocumentSemanticSearch).not.toHaveBeenCalled();
  });

  it("rejects invalid limits before authentication", async () => {
    for (const limit of [0, 26, 1.5]) {
      const response = await POST(request({ organizationId: "org-a", query: "pump", limit }));
      expect(response.status).toBe(400);
    }
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });

  it("returns authentication errors before semantic-search runtime composition", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      error: new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    });

    const response = await POST(request({ organizationId: "org-a", query: "pump maintenance" }));

    expect(response.status).toBe(401);
    expect(mocks.createServerControlledDocumentSemanticSearch).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("passes authenticated organization context, query and bounded limit to semantic search", async () => {
    const generated = {
      status: "generated" as const,
      result: {
        query: "pump maintenance",
        providerId: "openai",
        model: "operator-embedding-model",
        results: [
          {
            documentId: "doc-1",
            revisionId: "rev-1",
            documentCode: "WI-001",
            documentTitle: "Synthetic pump work instruction",
            revision: "A",
            checksumSha256: "a".repeat(64),
            score: 0.91,
            chunkText: "Synthetic maintenance instructions.",
          },
        ],
      },
    };
    mocks.search.mockResolvedValue(generated);

    const response = await POST(
      request({ organizationId: "org-a", query: "pump maintenance", limit: 5 }),
    );

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ data: generated });
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(expect.any(Request), "org-a");
    expect(mocks.createServerControlledDocumentSemanticSearch).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledWith({
      authorization: {
        organizationId: "org-a",
        actorId: "user-1",
        scope: auth.tenant.scope,
      },
      query: "pump maintenance",
      limit: 5,
    });
  });

  it("returns embedding provider fallback as successful API data", async () => {
    const unavailable = {
      status: "unavailable" as const,
      reason: "AI_DISABLED" as const,
      retryable: false,
      message: "AI is disabled. Core maintenance data and workflows remain available.",
    };
    mocks.search.mockResolvedValue(unavailable);

    const response = await POST(request({ organizationId: "org-a", query: "pump" }));

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ data: unavailable });
  });

  it("maps authorization failures without exposing diagnostics", async () => {
    mocks.search.mockRejectedValue(new AccessDeniedError("document permission diagnostic"));

    const response = await POST(request({ organizationId: "org-a", query: "pump" }));
    const body = await payload(response);

    expect(response.status).toBe(403);
    expect(body.error).toMatchObject({ code: "ACCESS_DENIED", message: "Access denied" });
    expect(JSON.stringify(body)).not.toContain("document permission diagnostic");
  });

  it("maps invalid requests and index/context failures safely", async () => {
    mocks.search.mockRejectedValueOnce(
      new ControlledDocumentSearchError("INVALID_REQUEST", "query diagnostic"),
    );
    const invalid = await POST(request({ organizationId: "org-a", query: "pump" }));
    const invalidBody = await payload(invalid);
    expect(invalid.status).toBe(400);
    expect(invalidBody.error?.code).toBe("INVALID_REQUEST");
    expect(JSON.stringify(invalidBody)).not.toContain("query diagnostic");

    mocks.search.mockRejectedValueOnce(
      new ControlledDocumentSearchError("INVALID_INDEX_METADATA", "vector metadata diagnostic"),
    );
    const context = await POST(request({ organizationId: "org-a", query: "pump" }));
    const contextBody = await payload(context);
    expect(context.status).toBe(500);
    expect(contextBody.error?.code).toBe("AI_SEARCH_CONTEXT_INVALID");
    expect(JSON.stringify(contextBody)).not.toContain("vector metadata diagnostic");
  });

  it("returns a safe 503 for invalid deployment embedding configuration", async () => {
    mocks.createServerControlledDocumentSemanticSearch.mockImplementation(() => {
      throw new AiRuntimeConfigurationError("OPENAI_API_KEY diagnostic");
    });

    const response = await POST(request({ organizationId: "org-a", query: "pump" }));
    const body = await payload(response);

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("AI_RUNTIME_MISCONFIGURED");
    expect(JSON.stringify(body)).not.toContain("OPENAI_API_KEY diagnostic");
  });

  it("redacts unexpected runtime failures", async () => {
    mocks.search.mockRejectedValue(new Error("vector database internal diagnostic"));

    const response = await POST(request({ organizationId: "org-a", query: "pump" }));
    const body = await payload(response);

    expect(response.status).toBe(500);
    expect(body.error?.code).toBe("AI_SEARCH_FAILED");
    expect(JSON.stringify(body)).not.toContain("vector database internal diagnostic");
  });
});
