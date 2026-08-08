import {
  createDisabledEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderEmbedInput,
  type EmbeddingProviderEmbedResult,
} from "@/lib/ai/embedding-provider";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_API_KEY_CHARS = 2_000;
const MAX_MODEL_CHARS = 200;
const MAX_DIMENSIONS = 65_536;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type OpenAiEmbeddingResponse = {
  data?: unknown;
  model?: unknown;
};

type OpenAiEmbeddingItem = {
  index?: unknown;
  embedding?: unknown;
};

function requiredText(value: string | undefined, label: string, maxLength: number) {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > maxLength || /[\u0000\r\n]/.test(normalized)) {
    throw new Error(`${label} configuration is invalid`);
  }
  return normalized;
}

function parseDimensions(value: string | undefined) {
  if (value === undefined || value.trim() === "") return null;
  if (!/^\d+$/.test(value.trim())) throw new Error("OpenAI embedding dimensions configuration is invalid");
  const dimensions = Number(value.trim());
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS) {
    throw new Error("OpenAI embedding dimensions configuration is invalid");
  }
  return dimensions;
}

async function readBoundedBody(response: Response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new Error("OpenAI embedding response exceeded the size limit");
  }

  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("OpenAI embedding response exceeded the size limit");
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("OpenAI embedding response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function parseResponse(response: Response, input: EmbeddingProviderEmbedInput) {
  if (!response.ok) throw new Error("OpenAI embedding request failed");

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new Error("OpenAI embedding response was not JSON");
  }

  const bytes = await readBoundedBody(response);
  let parsed: OpenAiEmbeddingResponse;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as OpenAiEmbeddingResponse;
  } catch {
    throw new Error("OpenAI embedding response was invalid");
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.data)) {
    throw new Error("OpenAI embedding response shape was invalid");
  }
  if (parsed.data.length !== input.inputs.length) {
    throw new Error("OpenAI embedding response count was invalid");
  }

  const byIndex = new Map<number, readonly number[]>();
  for (const rawItem of parsed.data) {
    if (!rawItem || typeof rawItem !== "object") {
      throw new Error("OpenAI embedding response item was invalid");
    }
    const item = rawItem as OpenAiEmbeddingItem;
    if (
      typeof item.index !== "number" ||
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= input.inputs.length ||
      byIndex.has(item.index) ||
      !Array.isArray(item.embedding) ||
      item.embedding.length < 1 ||
      item.embedding.length > MAX_DIMENSIONS ||
      item.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error("OpenAI embedding response item was invalid");
    }
    byIndex.set(item.index, item.embedding as number[]);
  }

  const first = byIndex.get(0);
  if (!first) throw new Error("OpenAI embedding response was incomplete");
  const dimensions = first.length;
  const embeddings = input.inputs.map((requested, index) => {
    const vector = byIndex.get(index);
    if (!vector || vector.length !== dimensions) {
      throw new Error("OpenAI embedding response dimensions were inconsistent");
    }
    return { id: requested.id, vector: [...vector] };
  });

  const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : input.model;
  if (model.length > MAX_MODEL_CHARS || /[\u0000\r\n]/.test(model)) {
    throw new Error("OpenAI embedding response model was invalid");
  }

  return { model, dimensions, embeddings } satisfies EmbeddingProviderEmbedResult;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai";
  readonly displayName = "OpenAI embeddings";
  readonly enabled = true;
  readonly defaultModel: string;
  readonly dimensions: number | null;

  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: {
    apiKey: string;
    model: string;
    dimensions?: number | null;
    fetchImpl?: FetchLike;
  }) {
    this.apiKey = requiredText(config.apiKey, "OpenAI API key", MAX_API_KEY_CHARS);
    this.defaultModel = requiredText(config.model, "OpenAI embedding model", MAX_MODEL_CHARS);
    this.dimensions = config.dimensions ?? null;
    this.fetchImpl = config.fetchImpl ?? fetch;
    if (
      this.dimensions !== null &&
      (!Number.isInteger(this.dimensions) || this.dimensions < 1 || this.dimensions > MAX_DIMENSIONS)
    ) {
      throw new Error("OpenAI embedding dimensions configuration is invalid");
    }
  }

  async embed(input: EmbeddingProviderEmbedInput): Promise<EmbeddingProviderEmbedResult> {
    const body = {
      model: input.model,
      input: input.inputs.map((item) => item.text),
      encoding_format: "float" as const,
      ...(this.dimensions === null ? {} : { dimensions: this.dimensions }),
    };

    const response = await this.fetchImpl(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      redirect: "error",
      signal: input.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    return parseResponse(response, input);
  }
}

export function createOpenAiEmbeddingProviderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: FetchLike,
): EmbeddingProvider {
  const apiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const model = env.OPENAI_EMBEDDING_MODEL?.trim() ?? "";

  if (!apiKey && !model && !env.OPENAI_EMBEDDING_DIMENSIONS?.trim()) {
    return createDisabledEmbeddingProvider({ id: "openai", displayName: "OpenAI embeddings" });
  }
  if (!apiKey || !model) {
    throw new Error("OpenAI embeddings require both OPENAI_API_KEY and OPENAI_EMBEDDING_MODEL");
  }

  return new OpenAiEmbeddingProvider({
    apiKey,
    model,
    dimensions: parseDimensions(env.OPENAI_EMBEDDING_DIMENSIONS),
    fetchImpl,
  });
}
