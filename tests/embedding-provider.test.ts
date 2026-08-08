import { describe, expect, it, vi } from "vitest";
import {
  createDisabledEmbeddingProvider,
  EmbeddingProviderRegistry,
  type EmbeddingProvider,
  type EmbeddingProviderEmbedInput,
  type EmbeddingProviderEmbedResult,
} from "@/lib/ai/embedding-provider";

function provider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    id: "test-embeddings",
    displayName: "Test Embeddings",
    enabled: true,
    defaultModel: "embed-v1",
    dimensions: 3,
    embed: vi.fn(async (input: EmbeddingProviderEmbedInput): Promise<EmbeddingProviderEmbedResult> => ({
      model: input.model,
      dimensions: 3,
      embeddings: input.inputs.map((item, index) => ({
        id: item.id,
        vector: [index + 0.1, index + 0.2, index + 0.3],
      })),
    })),
    ...overrides,
  };
}

const context = {
  organizationId: "org-a",
  siteId: "site-a",
  actorId: "user-a",
  purpose: "semantic-document-index",
  correlationId: "corr-1",
};

const inputs = [
  { id: "chunk-1", text: "Pump lubrication procedure" },
  { id: "chunk-2", text: "Bearing inspection procedure" },
];

describe("embedding provider abstraction", () => {
  it("routes a bounded tenant-scoped batch and validates vectors", async () => {
    const adapter = provider();
    const registry = new EmbeddingProviderRegistry([adapter]);

    const result = await registry.embed({
      providerId: adapter.id,
      context,
      inputs,
      timeoutMs: 1_000,
    });

    expect(adapter.embed).toHaveBeenCalledTimes(1);
    expect(adapter.embed).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        model: "embed-v1",
        inputs,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({
      providerId: "test-embeddings",
      model: "embed-v1",
      dimensions: 3,
      embeddings: [
        { id: "chunk-1", vector: [0.1, 0.2, 0.3] },
        { id: "chunk-2", vector: [1.1, 1.2, 1.3] },
      ],
    });
  });

  it("supports a model override without exposing adapter configuration", async () => {
    const adapter = Object.assign(provider(), {
      apiKey: "embedding-secret",
      endpoint: "https://private-embedding.example.test",
    });
    const registry = new EmbeddingProviderRegistry([adapter]);

    const result = await registry.embed({
      providerId: adapter.id,
      context,
      model: "embed-v2",
      inputs: [inputs[0]],
    });

    expect(adapter.embed).toHaveBeenCalledWith(expect.objectContaining({ model: "embed-v2" }));
    expect(result.model).toBe("embed-v2");
    const serialized = JSON.stringify(registry.list());
    expect(serialized).not.toContain("embedding-secret");
    expect(serialized).not.toContain("private-embedding.example.test");
  });

  it("requires tenant context before provider invocation", async () => {
    const adapter = provider();
    const registry = new EmbeddingProviderRegistry([adapter]);

    await expect(
      registry.embed({
        providerId: adapter.id,
        context: { ...context, organizationId: "" },
        inputs,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  it("rejects duplicate ids and oversized text before provider invocation", async () => {
    const adapter = provider();
    const registry = new EmbeddingProviderRegistry([adapter]);

    await expect(
      registry.embed({
        providerId: adapter.id,
        context,
        inputs: [inputs[0], { id: inputs[0].id, text: "duplicate" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      registry.embed({
        providerId: adapter.id,
        context,
        inputs: [{ id: "huge", text: "x".repeat(100_001) }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  it("rejects malformed dimensions, non-finite values and missing identities", async () => {
    const badDimension = new EmbeddingProviderRegistry([
      provider({
        embed: vi.fn(async (): Promise<EmbeddingProviderEmbedResult> => ({
          dimensions: 2,
          embeddings: inputs.map((item) => ({ id: item.id, vector: [1, 2] })),
        })),
      }),
    ]);
    await expect(
      badDimension.embed({ providerId: "test-embeddings", context, inputs }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const badValue = new EmbeddingProviderRegistry([
      provider({
        embed: vi.fn(async (): Promise<EmbeddingProviderEmbedResult> => ({
          dimensions: 3,
          embeddings: [
            { id: "chunk-1", vector: [1, Number.NaN, 3] },
            { id: "chunk-2", vector: [1, 2, 3] },
          ],
        })),
      }),
    ]);
    await expect(
      badValue.embed({ providerId: "test-embeddings", context, inputs }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const wrongIdentity = new EmbeddingProviderRegistry([
      provider({
        embed: vi.fn(async (): Promise<EmbeddingProviderEmbedResult> => ({
          dimensions: 3,
          embeddings: [
            { id: "chunk-1", vector: [1, 2, 3] },
            { id: "foreign", vector: [1, 2, 3] },
          ],
        })),
      }),
    ]);
    await expect(
      wrongIdentity.embed({ providerId: "test-embeddings", context, inputs }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("redacts provider exceptions", async () => {
    const registry = new EmbeddingProviderRegistry([
      provider({
        embed: vi.fn(async () => {
          throw new Error("401 api_key=embedding-secret upstream-private-body");
        }),
      }),
    ]);

    let caught: unknown;
    try {
      await registry.embed({ providerId: "test-embeddings", context, inputs });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(String(caught)).not.toContain("embedding-secret");
    expect(String(caught)).not.toContain("upstream-private-body");
  });

  it("enforces timeout and caller cancellation", async () => {
    const hanging = provider({
      embed: vi.fn(() => new Promise<EmbeddingProviderEmbedResult>(() => undefined)),
    });
    const registry = new EmbeddingProviderRegistry([hanging]);

    await expect(
      registry.embed({ providerId: hanging.id, context, inputs, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    const controller = new AbortController();
    controller.abort();
    const adapter = provider();
    const cancelled = new EmbeddingProviderRegistry([adapter]);
    await expect(
      cancelled.embed({ providerId: adapter.id, context, inputs, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  it("fails closed when embeddings are disabled", async () => {
    const disabled = createDisabledEmbeddingProvider();
    const spy = vi.spyOn(disabled, "embed");
    const registry = new EmbeddingProviderRegistry([disabled]);

    await expect(
      registry.embed({ providerId: disabled.id, context, inputs }),
    ).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    expect(spy).not.toHaveBeenCalled();
  });
});
