const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_ID_MAX_LENGTH = 200;
const PURPOSE_MAX_LENGTH = 100;
const INPUT_ID_MAX_LENGTH = 200;
const MAX_INPUTS = 128;
const MAX_TEXT_CHARS = 100_000;
const MAX_TOTAL_TEXT_CHARS = 500_000;
const MAX_DIMENSIONS = 65_536;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;

export type EmbeddingInvocationContext = {
  organizationId: string;
  siteId?: string | null;
  actorId?: string | null;
  purpose: string;
  correlationId?: string | null;
};

export type EmbeddingInput = {
  id: string;
  text: string;
};

export type EmbeddingProviderMetadata = {
  id: string;
  displayName: string;
  enabled: boolean;
  defaultModel: string | null;
  dimensions: number | null;
};

export type EmbeddingProviderEmbedInput = {
  context: Readonly<EmbeddingInvocationContext>;
  model: string;
  inputs: readonly Readonly<EmbeddingInput>[];
  signal: AbortSignal;
};

export type EmbeddingProviderVector = {
  id: string;
  vector: readonly number[];
};

export type EmbeddingProviderEmbedResult = {
  model?: string;
  dimensions: number;
  embeddings: readonly EmbeddingProviderVector[];
};

export interface EmbeddingProvider {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly defaultModel: string | null;
  readonly dimensions: number | null;
  embed(input: EmbeddingProviderEmbedInput): Promise<EmbeddingProviderEmbedResult>;
}

export type EmbeddingBatchResult = {
  providerId: string;
  model: string;
  dimensions: number;
  embeddings: Array<{ id: string; vector: number[] }>;
};

export class EmbeddingProviderError extends Error {
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
    this.name = "EmbeddingProviderError";
  }
}

function assertProviderId(id: string) {
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new EmbeddingProviderError(
      "INVALID_PROVIDER",
      "Embedding provider id must use lowercase letters, numbers, dots, underscores or dashes",
    );
  }
}

function normalizeModel(model: string | null | undefined, code: "INVALID_REQUEST" | "INVALID_RESPONSE") {
  const normalized = model?.trim() ?? "";
  if (!normalized || normalized.length > MODEL_ID_MAX_LENGTH || /[\u0000\r\n]/.test(normalized)) {
    throw new EmbeddingProviderError(code, "Embedding model id is invalid");
  }
  return normalized;
}

function normalizeDimensions(value: number, code: "INVALID_PROVIDER" | "INVALID_RESPONSE") {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSIONS) {
    throw new EmbeddingProviderError(
      code,
      `Embedding dimensions must be between 1 and ${MAX_DIMENSIONS}`,
    );
  }
  return value;
}

function normalizeContext(input: EmbeddingInvocationContext): EmbeddingInvocationContext {
  const organizationId = input.organizationId.trim();
  const siteId = input.siteId?.trim() || null;
  const actorId = input.actorId?.trim() || null;
  const purpose = input.purpose.trim();
  const correlationId = input.correlationId?.trim() || null;

  if (!organizationId) {
    throw new EmbeddingProviderError(
      "INVALID_REQUEST",
      "Embedding invocation organizationId is required",
    );
  }
  if (!purpose || purpose.length > PURPOSE_MAX_LENGTH || /[\u0000\r\n]/.test(purpose)) {
    throw new EmbeddingProviderError("INVALID_REQUEST", "Embedding invocation purpose is invalid");
  }
  for (const [name, value] of [
    ["siteId", siteId],
    ["actorId", actorId],
    ["correlationId", correlationId],
  ] as const) {
    if (value && (value.length > 200 || /[\u0000\r\n]/.test(value))) {
      throw new EmbeddingProviderError(
        "INVALID_REQUEST",
        `Embedding invocation ${name} is invalid`,
      );
    }
  }

  return { organizationId, siteId, actorId, purpose, correlationId };
}

function normalizeInputs(inputs: readonly EmbeddingInput[]) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_INPUTS) {
    throw new EmbeddingProviderError(
      "INVALID_REQUEST",
      `Embedding request must contain between 1 and ${MAX_INPUTS} inputs`,
    );
  }

  const seen = new Set<string>();
  let totalChars = 0;
  return inputs.map((input) => {
    const id = input?.id?.trim() ?? "";
    if (!id || id.length > INPUT_ID_MAX_LENGTH || /[\u0000\r\n]/.test(id) || seen.has(id)) {
      throw new EmbeddingProviderError("INVALID_REQUEST", "Embedding input id is invalid or duplicated");
    }
    if (typeof input.text !== "string" || !input.text.trim()) {
      throw new EmbeddingProviderError("INVALID_REQUEST", "Embedding input text is required");
    }
    if (input.text.length > MAX_TEXT_CHARS) {
      throw new EmbeddingProviderError(
        "INVALID_REQUEST",
        `Embedding input cannot exceed ${MAX_TEXT_CHARS} characters`,
      );
    }
    totalChars += input.text.length;
    if (totalChars > MAX_TOTAL_TEXT_CHARS) {
      throw new EmbeddingProviderError(
        "INVALID_REQUEST",
        `Embedding request cannot exceed ${MAX_TOTAL_TEXT_CHARS} text characters`,
      );
    }
    seen.add(id);
    return Object.freeze({ id, text: input.text });
  });
}

function normalizeTimeout(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new EmbeddingProviderError(
      "INVALID_REQUEST",
      `Embedding timeoutMs must be between 100 and ${MAX_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

function metadata(provider: EmbeddingProvider): EmbeddingProviderMetadata {
  return {
    id: provider.id,
    displayName: provider.displayName,
    enabled: provider.enabled,
    defaultModel: provider.defaultModel,
    dimensions: provider.dimensions,
  };
}

function validateProvider(provider: EmbeddingProvider) {
  assertProviderId(provider.id);
  if (!provider.displayName.trim() || provider.displayName.length > 100) {
    throw new EmbeddingProviderError("INVALID_PROVIDER", "Embedding provider displayName is invalid");
  }
  if (typeof provider.enabled !== "boolean" || typeof provider.embed !== "function") {
    throw new EmbeddingProviderError("INVALID_PROVIDER", "Embedding provider contract is invalid");
  }
  if (provider.defaultModel !== null) normalizeModel(provider.defaultModel, "INVALID_REQUEST");
  if (provider.dimensions !== null) normalizeDimensions(provider.dimensions, "INVALID_PROVIDER");
}

async function invokeWithDeadline<T>(input: {
  operation: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted) {
    throw new EmbeddingProviderError("ABORTED", "Embedding request was aborted");
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new EmbeddingProviderError("TIMEOUT", "Embedding provider request timed out"));
    }, input.timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (!input.signal) return;
    abortHandler = () => {
      controller.abort();
      reject(new EmbeddingProviderError("ABORTED", "Embedding request was aborted"));
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

function normalizeProviderResult(input: {
  provider: EmbeddingProvider;
  requestedModel: string;
  requestedInputs: readonly Readonly<EmbeddingInput>[];
  response: EmbeddingProviderEmbedResult;
}): Omit<EmbeddingBatchResult, "providerId"> {
  const dimensions = normalizeDimensions(input.response?.dimensions, "INVALID_RESPONSE");
  if (input.provider.dimensions !== null && dimensions !== input.provider.dimensions) {
    throw new EmbeddingProviderError(
      "INVALID_RESPONSE",
      "Embedding provider returned an unexpected vector dimension",
    );
  }
  const model =
    input.response.model === undefined
      ? input.requestedModel
      : normalizeModel(input.response.model, "INVALID_RESPONSE");
  if (!Array.isArray(input.response.embeddings) || input.response.embeddings.length !== input.requestedInputs.length) {
    throw new EmbeddingProviderError(
      "INVALID_RESPONSE",
      "Embedding provider returned an unexpected number of vectors",
    );
  }

  const expectedIds = new Set(input.requestedInputs.map((item) => item.id));
  const seen = new Set<string>();
  const embeddings = input.response.embeddings.map((item) => {
    if (!item || !expectedIds.has(item.id) || seen.has(item.id) || !Array.isArray(item.vector)) {
      throw new EmbeddingProviderError(
        "INVALID_RESPONSE",
        "Embedding provider returned invalid or duplicated input identities",
      );
    }
    if (item.vector.length !== dimensions || item.vector.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingProviderError(
        "INVALID_RESPONSE",
        "Embedding provider returned an invalid vector",
      );
    }
    seen.add(item.id);
    return { id: item.id, vector: [...item.vector] };
  });

  if (seen.size !== expectedIds.size) {
    throw new EmbeddingProviderError(
      "INVALID_RESPONSE",
      "Embedding provider did not return every requested input",
    );
  }

  return { model, dimensions, embeddings };
}

export class EmbeddingProviderRegistry {
  private readonly providers = new Map<string, EmbeddingProvider>();

  constructor(providers: readonly EmbeddingProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: EmbeddingProvider) {
    validateProvider(provider);
    if (this.providers.has(provider.id)) {
      throw new EmbeddingProviderError("INVALID_PROVIDER", "Embedding provider ids must be unique");
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  list(): EmbeddingProviderMetadata[] {
    return [...this.providers.values()].map(metadata);
  }

  get(providerId: string): EmbeddingProviderMetadata | null {
    const provider = this.providers.get(providerId);
    return provider ? metadata(provider) : null;
  }

  async embed(input: {
    providerId: string;
    context: EmbeddingInvocationContext;
    model?: string;
    inputs: readonly EmbeddingInput[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<EmbeddingBatchResult> {
    const provider = this.providers.get(input.providerId);
    if (!provider) {
      throw new EmbeddingProviderError("PROVIDER_NOT_FOUND", "Embedding provider is not registered");
    }
    if (!provider.enabled) {
      throw new EmbeddingProviderError("PROVIDER_DISABLED", "Embedding provider is disabled");
    }

    const context = Object.freeze(normalizeContext(input.context));
    const model = normalizeModel(input.model ?? provider.defaultModel, "INVALID_REQUEST");
    const inputs = Object.freeze(normalizeInputs(input.inputs));
    const timeoutMs = normalizeTimeout(input.timeoutMs);

    let response: EmbeddingProviderEmbedResult;
    try {
      response = await invokeWithDeadline({
        timeoutMs,
        signal: input.signal,
        operation: (signal) => provider.embed({ context, model, inputs, signal }),
      });
    } catch (error) {
      if (
        error instanceof EmbeddingProviderError &&
        (error.code === "ABORTED" || error.code === "TIMEOUT")
      ) {
        throw error;
      }
      throw new EmbeddingProviderError("PROVIDER_ERROR", "Embedding provider request failed");
    }

    const normalized = normalizeProviderResult({
      provider,
      requestedModel: model,
      requestedInputs: inputs,
      response,
    });
    return { providerId: provider.id, ...normalized };
  }
}

export function createDisabledEmbeddingProvider(input?: {
  id?: string;
  displayName?: string;
}): EmbeddingProvider {
  return {
    id: input?.id ?? "disabled",
    displayName: input?.displayName ?? "Embeddings disabled",
    enabled: false,
    defaultModel: null,
    dimensions: null,
    async embed() {
      throw new Error("Disabled embedding provider must never be invoked");
    },
  };
}
