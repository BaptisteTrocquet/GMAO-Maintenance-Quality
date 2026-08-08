import {
  createDisabledLlmProvider,
  type LlmFinishReason,
  type LlmProvider,
  type LlmProviderGenerateInput,
  type LlmProviderGenerateResult,
} from "@/lib/ai/llm-provider";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_API_KEY_CHARS = 2_000;
const MAX_MODEL_CHARS = 200;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type OpenAiResponse = {
  status?: unknown;
  model?: unknown;
  output?: unknown;
  incomplete_details?: unknown;
  usage?: unknown;
};

type OpenAiOutputItem = {
  type?: unknown;
  role?: unknown;
  content?: unknown;
};

type OpenAiContentItem = {
  type?: unknown;
  text?: unknown;
  refusal?: unknown;
};

function requiredText(value: string | undefined, label: string, maxLength: number) {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > maxLength || /[\u0000\r\n]/.test(normalized)) {
    throw new Error(`${label} configuration is invalid`);
  }
  return normalized;
}

async function readBoundedBody(response: Response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new Error("OpenAI response exceeded the size limit");
  }

  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("OpenAI response exceeded the size limit");
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
        throw new Error("OpenAI response exceeded the size limit");
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

function normalizedModel(value: unknown, fallback: string) {
  const model = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!model || model.length > MAX_MODEL_CHARS || /[\u0000\r\n]/.test(model)) {
    throw new Error("OpenAI response model was invalid");
  }
  return model;
}

function normalizeTokenCount(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("OpenAI response usage was invalid");
  }
  return value;
}

function finishReason(response: OpenAiResponse, sawRefusal: boolean): LlmFinishReason {
  if (sawRefusal) return "content_filter";
  if (response.status === "completed") return "stop";
  if (response.status !== "incomplete") return "other";

  const details = response.incomplete_details;
  const reason =
    details && typeof details === "object" && "reason" in details
      ? (details as { reason?: unknown }).reason
      : undefined;
  if (reason === "max_output_tokens" || reason === "max_tokens") return "length";
  if (reason === "content_filter") return "content_filter";
  return "other";
}

function parseOutput(response: OpenAiResponse) {
  if (!Array.isArray(response.output)) throw new Error("OpenAI response output was invalid");

  const textParts: string[] = [];
  const refusalParts: string[] = [];
  for (const rawItem of response.output) {
    if (!rawItem || typeof rawItem !== "object") {
      throw new Error("OpenAI response output item was invalid");
    }
    const item = rawItem as OpenAiOutputItem;
    if (item.type !== "message") continue;
    if (item.role !== "assistant" || !Array.isArray(item.content)) {
      throw new Error("OpenAI response message was invalid");
    }

    for (const rawContent of item.content) {
      if (!rawContent || typeof rawContent !== "object") {
        throw new Error("OpenAI response content was invalid");
      }
      const content = rawContent as OpenAiContentItem;
      if (content.type === "output_text") {
        if (typeof content.text !== "string") throw new Error("OpenAI response text was invalid");
        textParts.push(content.text);
      } else if (content.type === "refusal") {
        if (typeof content.refusal !== "string" || !content.refusal.trim()) {
          throw new Error("OpenAI response refusal was invalid");
        }
        refusalParts.push(content.refusal);
      }
    }
  }

  const sawRefusal = refusalParts.length > 0;
  const text = textParts.join("") || refusalParts.join("\n");
  if (!text) throw new Error("OpenAI response contained no text output");
  return { text, sawRefusal };
}

async function parseResponse(response: Response, input: LlmProviderGenerateInput) {
  if (!response.ok) throw new Error("OpenAI Responses request failed");

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new Error("OpenAI response was not JSON");

  const bytes = await readBoundedBody(response);
  let parsed: OpenAiResponse;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as OpenAiResponse;
  } catch {
    throw new Error("OpenAI response was invalid");
  }

  if (!parsed || typeof parsed !== "object") throw new Error("OpenAI response shape was invalid");
  if (parsed.status !== "completed" && parsed.status !== "incomplete") {
    throw new Error("OpenAI response status was invalid");
  }

  const output = parseOutput(parsed);
  const usageRaw = parsed.usage;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  if (usageRaw !== undefined && usageRaw !== null) {
    if (typeof usageRaw !== "object") throw new Error("OpenAI response usage was invalid");
    const raw = usageRaw as { input_tokens?: unknown; output_tokens?: unknown };
    usage = {
      inputTokens: normalizeTokenCount(raw.input_tokens),
      outputTokens: normalizeTokenCount(raw.output_tokens),
    };
  }

  return {
    text: output.text,
    model: normalizedModel(parsed.model, input.model),
    finishReason: finishReason(parsed, output.sawRefusal),
    ...(usage ? { usage } : {}),
  } satisfies LlmProviderGenerateResult;
}

export class OpenAiResponsesLlmProvider implements LlmProvider {
  readonly id = "openai";
  readonly displayName = "OpenAI Responses";
  readonly enabled = true;
  readonly defaultModel: string;
  readonly capabilities = {
    streaming: false,
    structuredOutput: false,
    toolCalling: false,
  } as const;

  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: { apiKey: string; model: string; fetchImpl?: FetchLike }) {
    this.apiKey = requiredText(config.apiKey, "OpenAI API key", MAX_API_KEY_CHARS);
    this.defaultModel = requiredText(config.model, "OpenAI LLM model", MAX_MODEL_CHARS);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async generate(input: LlmProviderGenerateInput): Promise<LlmProviderGenerateResult> {
    const body = {
      model: input.model,
      input: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      max_output_tokens: input.maxOutputTokens,
      store: false,
      ...(input.temperature === null ? {} : { temperature: input.temperature }),
    };

    const response = await this.fetchImpl(OPENAI_RESPONSES_URL, {
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

export function createOpenAiResponsesLlmProviderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: FetchLike,
): LlmProvider {
  const model = env.OPENAI_LLM_MODEL?.trim() ?? "";
  if (!model) {
    return createDisabledLlmProvider({ id: "openai", displayName: "OpenAI Responses" });
  }

  const apiKey = env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error("OpenAI LLM requires OPENAI_API_KEY when OPENAI_LLM_MODEL is set");

  return new OpenAiResponsesLlmProvider({ apiKey, model, fetchImpl });
}
