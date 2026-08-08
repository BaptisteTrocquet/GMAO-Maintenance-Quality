import {
  createAuditedAssetContextAssistant,
  createAuditedTroubleshootingAdvisor,
  createAuditedWorkOrderSummarizer,
} from "@/lib/ai/audit";
import { createControlledDocumentSemanticSearch } from "@/lib/ai/controlled-document-search";
import { EmbeddingProviderError } from "@/lib/ai/embedding-provider";
import { LlmProviderError } from "@/lib/ai/llm-provider";

export type AiUnavailableReason =
  | "AI_DISABLED"
  | "AI_NOT_CONFIGURED"
  | "AI_TEMPORARILY_UNAVAILABLE";

export type AiUnavailableState = {
  status: "unavailable";
  reason: AiUnavailableReason;
  retryable: boolean;
  message: string;
};

export type AiGeneratedState<T> = {
  status: "generated";
  result: T;
};

export type AiFeatureResult<T> = AiGeneratedState<T> | AiUnavailableState;

function unavailableState(error: unknown): AiUnavailableState | null {
  if (!(error instanceof LlmProviderError) && !(error instanceof EmbeddingProviderError)) {
    return null;
  }

  if (error.code === "PROVIDER_DISABLED") {
    return {
      status: "unavailable",
      reason: "AI_DISABLED",
      retryable: false,
      message: "AI is disabled. Core maintenance data and workflows remain available.",
    };
  }

  if (error.code === "PROVIDER_NOT_FOUND") {
    return {
      status: "unavailable",
      reason: "AI_NOT_CONFIGURED",
      retryable: false,
      message: "AI is not configured. Core maintenance data and workflows remain available.",
    };
  }

  if (
    error.code === "TIMEOUT" ||
    error.code === "PROVIDER_ERROR" ||
    error.code === "INVALID_RESPONSE"
  ) {
    return {
      status: "unavailable",
      reason: "AI_TEMPORARILY_UNAVAILABLE",
      retryable: true,
      message: "AI is temporarily unavailable. Core maintenance data and workflows remain available.",
    };
  }

  return null;
}

async function runWithProviderFallback<T>(operation: () => Promise<T>): Promise<AiFeatureResult<T>> {
  try {
    return { status: "generated", result: await operation() };
  } catch (error) {
    const fallback = unavailableState(error);
    if (fallback) return fallback;
    throw error;
  }
}

export function createResilientAssetContextAssistant(
  input: Parameters<typeof createAuditedAssetContextAssistant>[0],
) {
  const assistant = createAuditedAssetContextAssistant(input);
  return {
    async ask(
      args: Parameters<typeof assistant.ask>[0],
    ): Promise<AiFeatureResult<Awaited<ReturnType<typeof assistant.ask>>>> {
      return runWithProviderFallback(() => assistant.ask(args));
    },
  };
}

export function createResilientControlledDocumentSemanticSearch(
  input: Parameters<typeof createControlledDocumentSemanticSearch>[0],
) {
  const semanticSearch = createControlledDocumentSemanticSearch(input);
  return {
    async search(
      args: Parameters<typeof semanticSearch.search>[0],
    ): Promise<AiFeatureResult<Awaited<ReturnType<typeof semanticSearch.search>>>> {
      return runWithProviderFallback(() => semanticSearch.search(args));
    },
  };
}

export function createResilientWorkOrderSummarizer(
  input: Parameters<typeof createAuditedWorkOrderSummarizer>[0],
) {
  const summarizer = createAuditedWorkOrderSummarizer(input);
  return {
    async summarize(
      args: Parameters<typeof summarizer.summarize>[0],
    ): Promise<AiFeatureResult<Awaited<ReturnType<typeof summarizer.summarize>>>> {
      return runWithProviderFallback(() => summarizer.summarize(args));
    },
  };
}

export function createResilientTroubleshootingAdvisor(
  input: Parameters<typeof createAuditedTroubleshootingAdvisor>[0],
) {
  const advisor = createAuditedTroubleshootingAdvisor(input);
  return {
    async suggest(
      args: Parameters<typeof advisor.suggest>[0],
    ): Promise<AiFeatureResult<Awaited<ReturnType<typeof advisor.suggest>>>> {
      return runWithProviderFallback(() => advisor.suggest(args));
    },
  };
}
