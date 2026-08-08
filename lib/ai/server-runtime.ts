import { createResilientWorkOrderSummarizer } from "@/lib/ai/fallback";
import { LlmProviderRegistry } from "@/lib/ai/llm-provider";
import { createOpenAiResponsesLlmProviderFromEnv } from "@/lib/ai/openai-llm-provider";

export const SERVER_LLM_PROVIDER_ID = "openai";

export class AiRuntimeConfigurationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AiRuntimeConfigurationError";
  }
}

export function createServerLlmRegistry(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  try {
    return new LlmProviderRegistry([createOpenAiResponsesLlmProviderFromEnv(env)]);
  } catch (error) {
    throw new AiRuntimeConfigurationError("AI runtime configuration is invalid", error);
  }
}

export function createServerWorkOrderSummarizer(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return createResilientWorkOrderSummarizer({
    llmRegistry: createServerLlmRegistry(env),
    providerId: SERVER_LLM_PROVIDER_ID,
  });
}
