import { EmbeddingProviderRegistry } from "@/lib/ai/embedding-provider";
import {
  createResilientAssetContextAssistant,
  createResilientControlledDocumentSemanticSearch,
  createResilientWorkOrderSummarizer,
} from "@/lib/ai/fallback";
import { LlmProviderRegistry } from "@/lib/ai/llm-provider";
import { createOpenAiEmbeddingProviderFromEnv } from "@/lib/ai/openai-embedding-provider";
import { createOpenAiResponsesLlmProviderFromEnv } from "@/lib/ai/openai-llm-provider";
import { createPostgresVectorStore } from "@/lib/ai/postgres-vector-store";

export const SERVER_LLM_PROVIDER_ID = "openai";
export const SERVER_EMBEDDING_PROVIDER_ID = "openai";

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

export function createServerEmbeddingRegistry(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  try {
    return new EmbeddingProviderRegistry([createOpenAiEmbeddingProviderFromEnv(env)]);
  } catch (error) {
    throw new AiRuntimeConfigurationError("AI runtime configuration is invalid", error);
  }
}

export function createServerAssetContextAssistant(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return createResilientAssetContextAssistant({
    llmRegistry: createServerLlmRegistry(env),
    providerId: SERVER_LLM_PROVIDER_ID,
  });
}

export function createServerControlledDocumentSemanticSearch(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return createResilientControlledDocumentSemanticSearch({
    embeddingRegistry: createServerEmbeddingRegistry(env),
    embeddingProviderId: SERVER_EMBEDDING_PROVIDER_ID,
    vectorStore: createPostgresVectorStore(),
  });
}

export function createServerWorkOrderSummarizer(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return createResilientWorkOrderSummarizer({
    llmRegistry: createServerLlmRegistry(env),
    providerId: SERVER_LLM_PROVIDER_ID,
  });
}
