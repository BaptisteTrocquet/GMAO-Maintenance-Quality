import { describe, expect, it, vi } from "vitest";
import {
  createDisabledLlmProvider,
  LlmProviderRegistry,
  type LlmProvider,
  type LlmProviderGenerateInput,
  type LlmProviderGenerateResult,
} from "@/lib/ai/llm-provider";

function provider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: "test-provider",
    displayName: "Test Provider",
    enabled: true,
    defaultModel: "test-model-v1",
    capabilities: { streaming: false, structuredOutput: false, toolCalling: false },
    generate: vi.fn(async (input: LlmProviderGenerateInput) => ({
      text: `reply:${input.messages.at(-1)?.content ?? ""}`,
      model: input.model,
      finishReason: "stop" as const,
      usage: { inputTokens: 12, outputTokens: 4 },
    })),
    ...overrides,
  };
}

const context = {
  organizationId: "org-a",
  siteId: "site-a",
  actorId: "user-a",
  purpose: "work-order-summary",
  correlationId: "corr-1",
};

const request = {
  messages: [
    { role: "system" as const, content: "Use only authorized maintenance context." },
    { role: "user" as const, content: "Summarize WO-100." },
  ],
};

describe("LLM provider abstraction", () => {
  it("routes one normalized request through a registered provider", async () => {
    const adapter = provider();
    const registry = new LlmProviderRegistry([adapter]);

    const result = await registry.generate({
      providerId: "test-provider",
      context,
      request: { ...request, maxOutputTokens: 500, temperature: 0.2 },
      timeoutMs: 1_000,
    });

    expect(adapter.generate).toHaveBeenCalledTimes(1);
    expect(adapter.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        model: "test-model-v1",
        messages: request.messages,
        maxOutputTokens: 500,
        temperature: 0.2,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({
      providerId: "test-provider",
      model: "test-model-v1",
      text: "reply:Summarize WO-100.",
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 4 },
    });
  });

  it("allows callers to override the provider default model without changing adapters", async () => {
    const adapter = provider();
    const registry = new LlmProviderRegistry([adapter]);

    const result = await registry.generate({
      providerId: adapter.id,
      context,
      request: { ...request, model: "alternate-model" },
    });

    expect(adapter.generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "alternate-model" }),
    );
    expect(result.model).toBe("alternate-model");
  });

  it("exposes provider metadata without leaking adapter-specific configuration", () => {
    const adapter = Object.assign(provider(), {
      apiKey: "super-secret-provider-key",
      endpoint: "https://private-provider.example.test",
    });
    const registry = new LlmProviderRegistry([adapter]);

    const serialized = JSON.stringify(registry.list());

    expect(serialized).toContain("test-provider");
    expect(serialized).toContain("test-model-v1");
    expect(serialized).not.toContain("super-secret-provider-key");
    expect(serialized).not.toContain("private-provider.example.test");
  });

  it("rejects duplicate or malformed provider registrations", () => {
    expect(() => new LlmProviderRegistry([provider(), provider()])).toThrowError(
      expect.objectContaining({ code: "INVALID_PROVIDER" }),
    );
    expect(() =>
      new LlmProviderRegistry([provider({ id: "OpenAI With Spaces" })]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PROVIDER" }));
  });

  it("fails closed when AI is disabled and never invokes the disabled adapter", async () => {
    const disabled = createDisabledLlmProvider();
    const spy = vi.spyOn(disabled, "generate");
    const registry = new LlmProviderRegistry([disabled]);

    await expect(
      registry.generate({ providerId: disabled.id, context, request }),
    ).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires explicit tenant context before any provider call", async () => {
    const adapter = provider();
    const registry = new LlmProviderRegistry([adapter]);

    await expect(
      registry.generate({
        providerId: adapter.id,
        context: { ...context, organizationId: "" },
        request,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(adapter.generate).not.toHaveBeenCalled();
  });

  it("bounds prompt size, message count, output tokens and temperature before transport", async () => {
    const adapter = provider();
    const registry = new LlmProviderRegistry([adapter]);

    await expect(
      registry.generate({
        providerId: adapter.id,
        context,
        request: { messages: [{ role: "user", content: "x".repeat(100_001) }] },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      registry.generate({
        providerId: adapter.id,
        context,
        request: { ...request, maxOutputTokens: 100_000 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      registry.generate({
        providerId: adapter.id,
        context,
        request: { ...request, temperature: 3 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(adapter.generate).not.toHaveBeenCalled();
  });

  it("enforces a deadline even when a provider ignores the abort signal", async () => {
    const adapter = provider({
      generate: vi.fn(
        () => new Promise<LlmProviderGenerateResult>(() => undefined),
      ),
    });
    const registry = new LlmProviderRegistry([adapter]);

    await expect(
      registry.generate({ providerId: adapter.id, context, request, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("propagates caller cancellation as a stable generic error", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = provider();
    const registry = new LlmProviderRegistry([adapter]);

    await expect(
      registry.generate({
        providerId: adapter.id,
        context,
        request,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(adapter.generate).not.toHaveBeenCalled();
  });

  it("redacts provider exceptions instead of propagating provider secrets or diagnostics", async () => {
    const adapter = provider({
      generate: vi.fn(async () => {
        throw new Error("401 token=super-secret-provider-key upstream body=private");
      }),
    });
    const registry = new LlmProviderRegistry([adapter]);

    let caught: unknown;
    try {
      await registry.generate({ providerId: adapter.id, context, request });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(String(caught)).not.toContain("super-secret-provider-key");
    expect(String(caught)).not.toContain("upstream body");
  });

  it("rejects malformed provider responses instead of trusting adapter output", async () => {
    const registry = new LlmProviderRegistry([
      provider({
        generate: vi.fn(async (): Promise<LlmProviderGenerateResult> => ({
          text: "ok",
          finishReason: "stop",
          usage: { inputTokens: -1 },
        })),
      }),
    ]);

    await expect(
      registry.generate({ providerId: "test-provider", context, request }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
