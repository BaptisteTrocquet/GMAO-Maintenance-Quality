import { describe, expect, it, vi } from "vitest";
import { LlmProviderRegistry } from "@/lib/ai/llm-provider";
import {
  createOpenAiResponsesLlmProviderFromEnv,
  OpenAiResponsesLlmProvider,
} from "@/lib/ai/openai-llm-provider";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function registry(provider: OpenAiResponsesLlmProvider) {
  return new LlmProviderRegistry([provider]);
}

function generate(provider: OpenAiResponsesLlmProvider, temperature: number | null = 0.2) {
  return registry(provider).generate({
    providerId: "openai",
    context: {
      organizationId: "org-a",
      siteId: "site-a",
      purpose: "work-order-summary",
    },
    request: {
      messages: [
        { role: "system", content: "Summarize only the supplied maintenance facts." },
        { role: "user", content: "Pump P-100 vibration increased." },
        { role: "assistant", content: "Previous observation: bearing temperature was normal." },
      ],
      maxOutputTokens: 256,
      temperature,
    },
  });
}

describe("OpenAI Responses LLM provider", () => {
  it("stays disabled until an LLM model is explicitly configured", () => {
    for (const env of [
      {},
      { OPENAI_API_KEY: "shared-key" },
      {
        OPENAI_API_KEY: "shared-key",
        OPENAI_EMBEDDING_MODEL: "text-embedding-example",
      },
    ]) {
      const provider = createOpenAiResponsesLlmProviderFromEnv(env);
      const metadata = new LlmProviderRegistry([provider]).get("openai");
      expect(metadata).toEqual({
        id: "openai",
        displayName: "OpenAI Responses",
        enabled: false,
        defaultModel: null,
        capabilities: { streaming: false, structuredOutput: false, toolCalling: false },
      });
    }
  });

  it("requires the shared API key only after the LLM model activates the adapter", () => {
    expect(() =>
      createOpenAiResponsesLlmProviderFromEnv({
        OPENAI_LLM_MODEL: "gpt-example",
      }),
    ).toThrow("requires OPENAI_API_KEY");
  });

  it("sends provider-neutral messages to the fixed Responses endpoint with storage disabled", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-openai-key");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "gpt-example",
        input: [
          { role: "system", content: "Summarize only the supplied maintenance facts." },
          { role: "user", content: "Pump P-100 vibration increased." },
          { role: "assistant", content: "Previous observation: bearing temperature was normal." },
        ],
        max_output_tokens: 256,
        store: false,
        temperature: 0.2,
      });

      return jsonResponse({
        object: "response",
        status: "completed",
        model: "gpt-example-2026-01-01",
        output: [
          {
            type: "reasoning",
            id: "reasoning-1",
            summary: [{ type: "summary_text", text: "private reasoning summary" }],
          },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "Pump P-100 shows increased vibration.", annotations: [] },
            ],
          },
        ],
        incomplete_details: null,
        usage: { input_tokens: 42, output_tokens: 11, total_tokens: 53 },
        store: false,
      });
    });

    const provider = new OpenAiResponsesLlmProvider({
      apiKey: "synthetic-openai-key",
      model: "gpt-example",
      fetchImpl,
    });
    const result = await generate(provider);

    expect(result).toEqual({
      providerId: "openai",
      model: "gpt-example-2026-01-01",
      text: "Pump P-100 shows increased vibration.",
      finishReason: "stop",
      usage: { inputTokens: 42, outputTokens: 11 },
    });
    expect(result.text).not.toContain("private reasoning");
    expect(JSON.stringify(registry(provider).list())).not.toContain("synthetic-openai-key");
  });

  it("omits temperature when the provider-neutral request leaves it unset", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("temperature");
      expect(body.store).toBe(false);
      return jsonResponse({
        status: "completed",
        model: "gpt-example",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Summary." }],
          },
        ],
      });
    });
    const provider = new OpenAiResponsesLlmProvider({
      apiKey: "synthetic-key",
      model: "gpt-example",
      fetchImpl,
    });

    await expect(generate(provider, null)).resolves.toMatchObject({ text: "Summary." });
  });

  it("maps max-output incompleteness to the provider-neutral length finish reason", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: "incomplete",
        model: "gpt-example",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: [{ type: "output_text", text: "Partial summary" }],
          },
        ],
        usage: { input_tokens: 20, output_tokens: 256 },
      }),
    );
    const provider = new OpenAiResponsesLlmProvider({
      apiKey: "synthetic-key",
      model: "gpt-example",
      fetchImpl,
    });

    await expect(generate(provider)).resolves.toMatchObject({
      text: "Partial summary",
      finishReason: "length",
      usage: { inputTokens: 20, outputTokens: 256 },
    });
  });

  it("maps refusal output to content_filter without exposing non-text reasoning", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: "completed",
        model: "gpt-example",
        output: [
          { type: "reasoning", id: "reasoning-1", content: [{ type: "reasoning_text", text: "hidden" }] },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "I cannot provide that response." }],
          },
        ],
      }),
    );
    const provider = new OpenAiResponsesLlmProvider({
      apiKey: "synthetic-key",
      model: "gpt-example",
      fetchImpl,
    });

    await expect(generate(provider)).resolves.toMatchObject({
      text: "I cannot provide that response.",
      finishReason: "content_filter",
    });
  });

  it("redacts HTTP bodies and API keys through the registry error boundary", async () => {
    const secret = "synthetic-secret-key";
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { message: `diagnostic contains ${secret}` } },
        { status: 401 },
      ),
    );
    const provider = new OpenAiResponsesLlmProvider({
      apiKey: secret,
      model: "gpt-example",
      fetchImpl,
    });

    let caught: unknown;
    try {
      await generate(provider);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "PROVIDER_ERROR", message: "LLM provider request failed" });
    expect(String(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain("diagnostic contains");
  });

  it("rejects malformed, non-JSON and oversized Responses as redacted provider failures", async () => {
    const providers = [
      new OpenAiResponsesLlmProvider({
        apiKey: "synthetic-key",
        model: "gpt-example",
        fetchImpl: async () => new Response("not-json", { headers: { "content-type": "text/plain" } }),
      }),
      new OpenAiResponsesLlmProvider({
        apiKey: "synthetic-key",
        model: "gpt-example",
        fetchImpl: async () => jsonResponse({ status: "completed", output: [] }),
      }),
      new OpenAiResponsesLlmProvider({
        apiKey: "synthetic-key",
        model: "gpt-example",
        fetchImpl: async () =>
          new Response("{}", {
            headers: {
              "content-type": "application/json",
              "content-length": String(16 * 1024 * 1024 + 1),
            },
          }),
      }),
    ];

    for (const provider of providers) {
      await expect(generate(provider)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    }
  });

  it("passes the registry AbortSignal to the Responses HTTP request", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return jsonResponse({
        status: "completed",
        model: "gpt-example",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Summary." }],
          },
        ],
      });
    });
    const provider = new OpenAiResponsesLlmProvider({
      apiKey: "synthetic-key",
      model: "gpt-example",
      fetchImpl,
    });

    await generate(provider);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });
});
