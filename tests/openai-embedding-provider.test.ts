import { describe, expect, it, vi } from "vitest";
import { EmbeddingProviderRegistry } from "@/lib/ai/embedding-provider";
import {
  createOpenAiEmbeddingProviderFromEnv,
  OpenAiEmbeddingProvider,
} from "@/lib/ai/openai-embedding-provider";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function context() {
  return { organizationId: "org-a", purpose: "controlled-document-semantic-search" };
}

async function embedWith(provider: OpenAiEmbeddingProvider, inputs = [
  { id: "a", text: "Pump inspection" },
  { id: "b", text: "Seal replacement" },
]) {
  return new EmbeddingProviderRegistry([provider]).embed({
    providerId: "openai",
    context: context(),
    inputs,
  });
}

describe("OpenAI embedding provider", () => {
  it("returns the normal disabled provider when the embedding model is unconfigured", () => {
    for (const env of [{}, { OPENAI_API_KEY: "shared-openai-key", OPENAI_LLM_MODEL: "gpt-example" }]) {
      const provider = createOpenAiEmbeddingProviderFromEnv(env);
      const registry = new EmbeddingProviderRegistry([provider]);

      expect(registry.get("openai")).toEqual({
        id: "openai",
        displayName: "OpenAI embeddings",
        enabled: false,
        defaultModel: null,
        dimensions: null,
      });
    }
  });

  it("rejects embedding-specific partial configuration", () => {
    expect(() =>
      createOpenAiEmbeddingProviderFromEnv({
        OPENAI_EMBEDDING_MODEL: "text-embedding-example",
      }),
    ).toThrow("require OPENAI_API_KEY");

    expect(() =>
      createOpenAiEmbeddingProviderFromEnv({
        OPENAI_API_KEY: "synthetic-key",
        OPENAI_EMBEDDING_DIMENSIONS: "256",
      }),
    ).toThrow("OPENAI_EMBEDDING_MODEL is required");
  });

  it("sends a batched float request and maps provider indexes back to stable input ids", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/embeddings");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-openai-key");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "text-embedding-example",
        input: ["Pump inspection", "Seal replacement"],
        encoding_format: "float",
      });

      return jsonResponse({
        object: "list",
        model: "text-embedding-example",
        data: [
          { object: "embedding", index: 1, embedding: [0, 1, 0] },
          { object: "embedding", index: 0, embedding: [1, 0, 0] },
        ],
      });
    });

    const provider = new OpenAiEmbeddingProvider({
      apiKey: "synthetic-openai-key",
      model: "text-embedding-example",
      fetchImpl,
    });
    const result = await embedWith(provider);

    expect(result).toEqual({
      providerId: "openai",
      model: "text-embedding-example",
      dimensions: 3,
      embeddings: [
        { id: "a", vector: [1, 0, 0] },
        { id: "b", vector: [0, 1, 0] },
      ],
    });
    expect(JSON.stringify(new EmbeddingProviderRegistry([provider]).list())).not.toContain(
      "synthetic-openai-key",
    );
  });

  it("sends configured output dimensions without hard-coding a model dimension", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "text-embedding-example",
        input: ["Pump inspection", "Seal replacement"],
        encoding_format: "float",
        dimensions: 2,
      });
      return jsonResponse({
        model: "text-embedding-example",
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [0, 1] },
        ],
      });
    });

    const provider = createOpenAiEmbeddingProviderFromEnv(
      {
        OPENAI_API_KEY: "synthetic-key",
        OPENAI_EMBEDDING_MODEL: "text-embedding-example",
        OPENAI_EMBEDDING_DIMENSIONS: "2",
      },
      fetchImpl,
    );
    const registry = new EmbeddingProviderRegistry([provider]);
    await expect(
      registry.embed({
        providerId: "openai",
        context: context(),
        inputs: [
          { id: "a", text: "Pump inspection" },
          { id: "b", text: "Seal replacement" },
        ],
      }),
    ).resolves.toMatchObject({ dimensions: 2 });
  });

  it("rejects duplicate, missing or malformed indexes through the redacted provider error boundary", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: "text-embedding-example",
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] },
        ],
      }),
    );
    const provider = new OpenAiEmbeddingProvider({
      apiKey: "synthetic-key",
      model: "text-embedding-example",
      fetchImpl,
    });

    await expect(embedWith(provider)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "Embedding provider request failed",
    });
  });

  it("redacts HTTP response bodies and API keys from provider failures", async () => {
    const secret = "synthetic-secret-key";
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { message: `upstream diagnostic accidentally mentions ${secret}` } },
        { status: 401 },
      ),
    );
    const provider = new OpenAiEmbeddingProvider({
      apiKey: secret,
      model: "text-embedding-example",
      fetchImpl,
    });

    let caught: unknown;
    try {
      await embedWith(provider);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(String(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain("upstream diagnostic");
  });

  it("rejects oversized responses before JSON parsing", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(16 * 1024 * 1024 + 1),
        },
      }),
    );
    const provider = new OpenAiEmbeddingProvider({
      apiKey: "synthetic-key",
      model: "text-embedding-example",
      fetchImpl,
    });

    await expect(embedWith(provider)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("passes the registry AbortSignal into the HTTP request", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return jsonResponse({
        model: "text-embedding-example",
        data: [{ index: 0, embedding: [1, 0] }],
      });
    });
    const provider = new OpenAiEmbeddingProvider({
      apiKey: "synthetic-key",
      model: "text-embedding-example",
      fetchImpl,
    });

    await embedWith(provider, [{ id: "a", text: "Pump inspection" }]);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });
});
