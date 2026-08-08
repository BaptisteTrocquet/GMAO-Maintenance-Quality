import { describe, expect, it } from "vitest";
import {
  AiRuntimeConfigurationError,
  createServerAssetContextAssistant,
  createServerLlmRegistry,
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

  it("composes the resilient Asset Context Assistant even when the provider is disabled", () => {
    const assistant = createServerAssetContextAssistant({});

    expect(assistant).toEqual({ ask: expect.any(Function) });
  });

  it("registers the configured OpenAI provider without exposing its shared API key", () => {
    const secret = "synthetic-server-runtime-key";
    const registry = createServerLlmRegistry({
      OPENAI_API_KEY: secret,
      OPENAI_LLM_MODEL: "operator-model",
    });

    expect(registry.get("openai")).toEqual({
      id: "openai",
      displayName: "OpenAI Responses",
      enabled: true,
      defaultModel: "operator-model",
      capabilities: { streaming: false, structuredOutput: false, toolCalling: false },
    });
    expect(JSON.stringify(registry.list())).not.toContain(secret);
  });

  it("wraps deployment configuration errors without exposing the underlying secret-bearing message", () => {
    let caught: unknown;
    try {
      createServerLlmRegistry({ OPENAI_LLM_MODEL: "operator-model" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AiRuntimeConfigurationError);
    expect(caught).toMatchObject({ message: "AI runtime configuration is invalid" });
    expect(String(caught)).not.toContain("OPENAI_API_KEY");
  });
});
