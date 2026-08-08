import {
  AiContextPolicyError,
  assertAiPromptMessagesSafe,
} from "@/lib/ai/context-policy";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_ID_MAX_LENGTH = 200;
const PURPOSE_MAX_LENGTH = 100;
const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_TOTAL_MESSAGE_CHARS = 300_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;
const MAX_OUTPUT_TOKENS = 32_768;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_CHARS = 1_000_000;

export type LlmMessageRole = "system" | "user" | "assistant";

export type LlmMessage = {
  role: LlmMessageRole;
  content: string;
};

export type LlmInvocationContext = {
  organizationId: string;
  siteId?: string | null;
  actorId?: string | null;
  purpose: string;
  correlationId?: string | null;
};

export type LlmGenerateRequest = {
  model?: string;
  messages: readonly LlmMessage[];
  maxOutputTokens?: number;
  temperature?: number | null;
};

export type LlmFinishReason = "stop" | "length" | "content_filter" | "other";

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type LlmProviderCapabilities = {
  streaming: boolean;
  structuredOutput: boolean;
  toolCalling: boolean;
};

export type LlmProviderMetadata = {
  id: string;
  displayName: string;
  enabled: boolean;
  defaultModel: string | null;
  capabilities: LlmProviderCapabilities;
};

export type LlmProviderGenerateInput = {
  context: Readonly<LlmInvocationContext>;
  model: string;
  messages: readonly LlmMessage[];
  maxOutputTokens: number;
  temperature: number | null;
  signal: AbortSignal;
};

export type LlmProviderGenerateResult = {
  text: string;
  model?: string;
  finishReason?: LlmFinishReason;
  usage?: LlmUsage;
};

export interface LlmProvider {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly defaultModel: string | null;
  readonly capabilities: LlmProviderCapabilities;
  generate(input: LlmProviderGenerateInput): Promise<LlmProviderGenerateResult>;
}

export type LlmGenerationResult = {
  providerId: string;
  model: string;
  text: string;
  finishReason: LlmFinishReason;
  usage: LlmUsage | null;
};

export class LlmProviderError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PROVIDER"
      | "PROVIDER_NOT_FOUND"
      | "PROVIDER_DISABLED"
      | "INVALID_REQUEST"
      | "ABORTED"
      | "TIMEOUT"
      | "PROVIDER_ERROR"
      | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

function assertProviderId(id: string) {
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new LlmProviderError(
      "INVALID_PROVIDER",
      "LLM provider id must use lowercase letters, numbers, dots, underscores or dashes",
    );
  }
}

function normalizeModel(model: string | null | undefined) {
  const normalized = model?.trim() ?? "";
  if (!normalized || normalized.length > MODEL_ID_MAX_LENGTH || /[\u0000\r\n]/.test(normalized)) {
    throw new LlmProviderError("INVALID_REQUEST", "LLM model id is invalid");
  }
  return normalized;
}

function normalizeContext(input: LlmInvocationContext): LlmInvocationContext {
  const organizationId = input.organizationId.trim();
  const siteId = input.siteId?.trim() || null;
  const actorId = input.actorId?.trim() || null;
  const purpose = input.purpose.trim();
  const correlationId = input.correlationId?.trim() || null;

  if (!organizationId) {
    throw new LlmProviderError("INVALID_REQUEST", "LLM invocation organizationId is required");
  }
  if (!purpose || purpose.length > PURPOSE_MAX_LENGTH || /[\u0000\r\n]/.test(purpose)) {
    throw new LlmProviderError("INVALID_REQUEST", "LLM invocation purpose is invalid");
  }
  for (const [name, value] of [
    ["siteId", siteId],
    ["actorId", actorId],
    ["correlationId", correlationId],
  ] as const) {
    if (value && (value.length > 200 || /[\u0000\r\n]/.test(value))) {
      throw new LlmProviderError("INVALID_REQUEST", `LLM invocation ${name} is invalid`);
    }
  }

  return { organizationId, siteId, actorId, purpose, correlationId };
}

function normalizeMessages(messages: readonly LlmMessage[]) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
    throw new LlmProviderError(
      "INVALID_REQUEST",
      `LLM request must contain between 1 and ${MAX_MESSAGES} messages`,
    );
  }

  let totalChars = 0;
  return messages.map((message) => {
    if (
      !message ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      !message.content.trim()
    ) {
      throw new LlmProviderError("INVALID_REQUEST", "LLM request contains an invalid message");
    }
    if (message.content.length > MAX_MESSAGE_CHARS) {
      throw new LlmProviderError(
        "INVALID_REQUEST",
        `LLM message cannot exceed ${MAX_MESSAGE_CHARS} characters`,
      );
    }
    totalChars += message.content.length;
    if (totalChars > MAX_TOTAL_MESSAGE_CHARS) {
      throw new LlmProviderError(
        "INVALID_REQUEST",
        `LLM request cannot exceed ${MAX_TOTAL_MESSAGE_CHARS} message characters`,
      );
    }
    return Object.freeze({ role: message.role, content: message.content });
  });
}

function assertMessagesPassSensitiveFieldPolicy(messages: readonly LlmMessage[]) {
  try {
    assertAiPromptMessagesSafe(messages);
  } catch (error) {
    if (error instanceof AiContextPolicyError) {
      throw new LlmProviderError(
        "INVALID_REQUEST",
        "LLM request violates the AI sensitive-field policy",
      );
    }
    throw error;
  }
}

function normalizeMaxOutputTokens(value: number | undefined) {
  const tokens = value ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > MAX_OUTPUT_TOKENS) {
    throw new LlmProviderError(
      "INVALID_REQUEST",
      `LLM maxOutputTokens must be between 1 and ${MAX_OUTPUT_TOKENS}`,
    );
  }
  return tokens;
}

function normalizeTemperature(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new LlmProviderError("INVALID_REQUEST", "LLM temperature must be between 0 and 2");
  }
  return value;
}

function normalizeTimeout(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new LlmProviderError(
      "INVALID_REQUEST",
      `LLM timeoutMs must be between 100 and ${MAX_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

function normalizeUsage(usage: LlmUsage | undefined): LlmUsage | null {
  if (!usage) return null;
  const normalized: LlmUsage = {};
  for (const [name, value] of [
    ["inputTokens", usage.inputTokens],
    ["outputTokens", usage.outputTokens],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
      throw new LlmProviderError("INVALID_RESPONSE", `LLM provider returned invalid ${name}`);
    }
    normalized[name] = value;
  }
  return normalized;
}

function metadata(provider: LlmProvider): LlmProviderMetadata {
  return {
    id: provider.id,
    displayName: provider.displayName,
    enabled: provider.enabled,
    defaultModel: provider.defaultModel,
    capabilities: { ...provider.capabilities },
  };
}

function validateProvider(provider: LlmProvider) {
  assertProviderId(provider.id);
  if (!provider.displayName.trim() || provider.displayName.length > 100) {
    throw new LlmProviderError("INVALID_PROVIDER", "LLM provider displayName is invalid");
  }
  if (provider.defaultModel !== null) normalizeModel(provider.defaultModel);
  if (
    !provider.capabilities ||
    typeof provider.capabilities.streaming !== "boolean" ||
    typeof provider.capabilities.structuredOutput !== "boolean" ||
    typeof provider.capabilities.toolCalling !== "boolean" ||
    typeof provider.generate !== "function"
  ) {
    throw new LlmProviderError("INVALID_PROVIDER", "LLM provider contract is invalid");
  }
}

async function invokeWithDeadline<T>(input: {
  operation: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted) {
    throw new LlmProviderError("ABORTED", "LLM request was aborted");
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new LlmProviderError("TIMEOUT", "LLM provider request timed out"));
    }, input.timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (!input.signal) return;
    abortHandler = () => {
      controller.abort();
      reject(new LlmProviderError("ABORTED", "LLM request was aborted"));
    };
    input.signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([input.operation(controller.signal), timeoutPromise, abortPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (abortHandler && input.signal) input.signal.removeEventListener("abort", abortHandler);
  }
}

export class LlmProviderRegistry {
  private readonly providers = new Map<string, LlmProvider>();

  constructor(providers: readonly LlmProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: LlmProvider) {
    validateProvider(provider);
    if (this.providers.has(provider.id)) {
      throw new LlmProviderError("INVALID_PROVIDER", "LLM provider ids must be unique");
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  list(): LlmProviderMetadata[] {
    return [...this.providers.values()].map(metadata);
  }

  get(providerId: string): LlmProviderMetadata | null {
    const provider = this.providers.get(providerId);
    return provider ? metadata(provider) : null;
  }

  async generate(input: {
    providerId: string;
    context: LlmInvocationContext;
    request: LlmGenerateRequest;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<LlmGenerationResult> {
    const provider = this.providers.get(input.providerId);
    if (!provider) {
      throw new LlmProviderError("PROVIDER_NOT_FOUND", "LLM provider is not registered");
    }
    if (!provider.enabled) {
      throw new LlmProviderError("PROVIDER_DISABLED", "LLM provider is disabled");
    }

    const context = Object.freeze(normalizeContext(input.context));
    const model = normalizeModel(input.request.model ?? provider.defaultModel);
    const messages = Object.freeze(normalizeMessages(input.request.messages));
    assertMessagesPassSensitiveFieldPolicy(messages);
    const maxOutputTokens = normalizeMaxOutputTokens(input.request.maxOutputTokens);
    const temperature = normalizeTemperature(input.request.temperature);
    const timeoutMs = normalizeTimeout(input.timeoutMs);

    let response: LlmProviderGenerateResult;
    try {
      response = await invokeWithDeadline({
        timeoutMs,
        signal: input.signal,
        operation: (signal) =>
          provider.generate({
            context,
            model,
            messages,
            maxOutputTokens,
            temperature,
            signal,
          }),
      });
    } catch (error) {
      if (
        error instanceof LlmProviderError &&
        (error.code === "ABORTED" || error.code === "TIMEOUT")
      ) {
        throw error;
      }
      throw new LlmProviderError("PROVIDER_ERROR", "LLM provider request failed");
    }

    if (!response || typeof response.text !== "string" || response.text.length > MAX_RESPONSE_CHARS) {
      throw new LlmProviderError("INVALID_RESPONSE", "LLM provider returned an invalid response");
    }
    const responseModel = response.model === undefined ? model : normalizeModel(response.model);
    const finishReason = response.finishReason ?? "other";
    if (!["stop", "length", "content_filter", "other"].includes(finishReason)) {
      throw new LlmProviderError("INVALID_RESPONSE", "LLM provider returned an invalid finish reason");
    }

    return {
      providerId: provider.id,
      model: responseModel,
      text: response.text,
      finishReason,
      usage: normalizeUsage(response.usage),
    };
  }
}

export function createDisabledLlmProvider(input?: {
  id?: string;
  displayName?: string;
}): LlmProvider {
  const id = input?.id ?? "disabled";
  const displayName = input?.displayName ?? "AI disabled";
  return {
    id,
    displayName,
    enabled: false,
    defaultModel: null,
    capabilities: { streaming: false, structuredOutput: false, toolCalling: false },
    async generate() {
      throw new Error("Disabled LLM provider must never be invoked");
    },
  };
}
