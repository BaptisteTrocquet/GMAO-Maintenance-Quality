import { describe, expect, it } from "vitest";
import {
  AiRuntimeConfigurationError,
  createServerAssetContextAssistant,
  createServerControlledDocumentSemanticSearch,
  createServerEmbeddingRegistry,
  createServerLlmRegistry,
  SERVER_EMBEDDING_PROVIDER_ID,
  SERVER_LLM_PROVIDER_ID,
} from "@/lib/ai/server-runtime";

describe("server AI runtime", () => {
  it("registers the OpenAI provider in disabled mode when no LLM model is configured", () => {
    const registry = createServerLlmRegistry({});

    expect(SERVER_LLM_PROVIDER_ID).toBe("openai");
    expect(registry.get("openai")).toEqual({
      id: "openai",
      displayName: "OpenAI Responses",
      enabled: false,
      defaultModel: null,
      capabilities: { streaming: false, structuredOutput: false, toolCalling: false },
    });
  });

  it("registers the OpenAI embedding provider in disabled mode when no model is configured", () => {
    const registry = createServerEmbeddingRegistry({});

    expect(SERVER_EMBEDDING_PROVIDER_ID).toBe("openai");
    expect(registry.get("openai")).toEqual({
      id: "openai",
      displayName: "OpenAI embeddings",
      enabled: false,
      defaultModel: null,
      dimensions: null,
    });
  });

  it("composes resilient AI read features even when their providers are disabled", () => {
    const assistant = createServerAssetContextAssistant({});
    const semanticSearch = createServerControlledDocumentSemanticSearch({});

    expect(assistant).toEqual({ ask: expect.any(Function) });
    expect(semanticSearch).toEqual({ search: expect.any(Function) });
  });

  it("registers configured OpenAI providers without exposing the shared API key", () => {
    const secret = "synthetic-server-runtime-key";
    const llmRegistry = createServerLlmRegistry({
      OPENAI_API_KEY: secret,
      OPENAI_LLM_MODEL: "operator-model",
    });
    const embeddingRegistry = createServerEmbeddingRegistry({
      OPENAI_API_KEY: secret,
      OPENAI_EMBEDDING_MODEL: "operator-embedding-model",
      OPENAI_EMBEDDING_DIMENSIONS: "1536",
    });

    expect(llmRegistry.get("openai")).toEqual({
      id: "openai",
      displayName: "OpenAI Responses",
      enabled: true,
      defaultModel: "operator-model",
      capabilities: { streaming: false, structuredOutput: false, toolCalling: false },
    });
    expect(embeddingRegistry.get("openai")).toEqual({
      id: "openai",
      displayName: "OpenAI embeddings",
      enabled: true,
      defaultModel: "operator-embedding-model",
      dimensions: 1536,
    });
    expect(JSON.stringify(llmRegistry.list())).not.toContain(secret);
    expect(JSON.stringify(embeddingRegistry.list())).not.toContain(secret);
  });

  it("wraps deployment configuration errors without exposing the underlying secret-bearing message", () => {
    let llmError: unknown;
    try {
      createServerLlmRegistry({ OPENAI_LLM_MODEL: "operator-model" });
    } catch (error) {
      llmError = error;
    }

    let embeddingError: unknown;
    try {
      createServerEmbeddingRegistry({ OPENAI_EMBEDDING_MODEL: "operator-embedding-model" });
    } catch (error) {
      embeddingError = error;
    }

    for (const caught of [llmError, embeddingError]) {
      expect(caught).toBeInstanceOf(AiRuntimeConfigurationError);
      expect(caught).toMatchObject({ message: "AI runtime configuration is invalid" });
      expect(String(caught)).not.toContain("OPENAI_API_KEY");
    }
  });
});
