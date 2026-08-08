# LLM provider abstraction

OpenGMAO treats AI as an optional capability. Core maintenance and Quality workflows do not depend on one LLM vendor or on AI being available.

The provider-neutral contract lives in `lib/ai/llm-provider.ts`. The repository-provided optional OpenAI adapter lives in `lib/ai/openai-llm-provider.ts` and is documented in `docs/AI_OPENAI_RESPONSES.md`.

## Boundary

Application features call `LlmProviderRegistry.generate(...)`. Vendor adapters implement the `LlmProvider` interface behind that registry.

The provider-neutral abstraction deliberately does **not** contain:

- vendor API keys or private endpoints;
- document retrieval;
- authorization decisions;
- prompt logging;
- persistence or audit events;
- retry policy or vendor-specific rate-limit handling.

Those concerns remain separate boundaries. Carrying `organizationId` and optional `siteId` in `LlmInvocationContext` does not authorize a request. A feature must authenticate and authorize the caller **before** retrieval and before `generate(...)` is invoked.

Provider adapters remain server-only. OpenAI is one optional implementation, not a dependency of the core provider contract.

## Provider contract

A provider exposes only safe metadata plus one generation method:

```ts
interface LlmProvider {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly defaultModel: string | null;
  readonly capabilities: {
    streaming: boolean;
    structuredOutput: boolean;
    toolCalling: boolean;
  };

  generate(input: LlmProviderGenerateInput): Promise<LlmProviderGenerateResult>;
}
```

The generation input contains normalized tenant/correlation context, the selected model, bounded messages, output-token limit, optional temperature and an `AbortSignal`.

Provider-specific configuration stays inside the adapter. `registry.list()` and `registry.get()` return a metadata projection and therefore cannot accidentally expose adapter fields such as API keys or private endpoints.

## Request safety

The registry validates requests before the adapter is called:

- 1 to 64 messages;
- supported roles: `system`, `user`, `assistant`;
- 100,000 characters maximum per message;
- 300,000 message characters maximum per request;
- 1 to 32,768 requested output tokens;
- temperature between 0 and 2;
- model identifiers are bounded and cannot contain newlines or NUL;
- invocation context requires an organization and a short purpose string;
- timeout defaults to 20 seconds and is capped at 120 seconds;
- prompt messages pass the AI sensitive-field policy before provider invocation.

These are defensive application limits and do not replace provider-specific token/context limits.

## Failure model

`LlmProviderError` gives callers a stable provider-independent error contract:

- `PROVIDER_NOT_FOUND`
- `PROVIDER_DISABLED`
- `INVALID_REQUEST`
- `ABORTED`
- `TIMEOUT`
- `PROVIDER_ERROR`
- `INVALID_RESPONSE`

Unknown exceptions from adapters are converted to the generic `PROVIDER_ERROR` message. Provider diagnostics, HTTP response bodies and credentials are not propagated through this layer.

The deadline is enforced with `Promise.race`, so an adapter that ignores its `AbortSignal` cannot hold an application request indefinitely.

## Disabled provider

`createDisabledLlmProvider()` supplies an explicit provider entry that cannot generate. The registry rejects it with `PROVIDER_DISABLED` before its adapter method is called.

`createOpenAiResponsesLlmProviderFromEnv()` returns this disabled state unless `OPENAI_LLM_MODEL` is explicitly configured. This preserves the provider-disabled fallback for deployments that do not enable generative AI.

## Repository OpenAI adapter

The repository includes an optional OpenAI Responses adapter:

```ts
const registry = new LlmProviderRegistry([
  createOpenAiResponsesLlmProviderFromEnv(process.env),
]);
```

When enabled, it uses a fixed server-side OpenAI Responses endpoint and `store: false`, maps the provider-neutral message sequence to the Responses API, parses only assistant output text/refusals, ignores reasoning output items, maps usage/finish state back to the provider-neutral contract, and keeps credentials/upstream error bodies behind the adapter boundary.

The baseline capabilities remain conservative: no streaming, structured output or tool calling is advertised because current OpenGMAO generative features only require bounded text generation.

See `docs/AI_OPENAI_RESPONSES.md` for configuration and transport details.

## Alternate adapters

Other vendors or local models can be registered without changing application feature code:

```ts
const registry = new LlmProviderRegistry([
  {
    id: "vendor-a",
    displayName: "Vendor A",
    enabled: true,
    defaultModel: "model-1",
    capabilities: {
      streaming: false,
      structuredOutput: false,
      toolCalling: false,
    },
    async generate(input) {
      return {
        text: "...",
        model: input.model,
        finishReason: "stop",
      };
    },
  },
]);
```

Vendor adapters should remain server-only and apply the same secret-handling principles as the OpenAI and E12 connector credential boundaries.

## Tests

`tests/llm-provider.test.ts` covers the provider-neutral registry contract: registration/routing, model selection, safe metadata, disabled providers, tenant context, sensitive-field policy, request/output bounds, timeout/cancellation, provider-error redaction and response validation.

`tests/openai-llm-provider.test.ts` covers the optional OpenAI adapter with a fake transport only: fixed endpoint, `store: false`, message mapping, usage/finish parsing, reasoning exclusion, refusals, malformed/oversized responses, secret/error-body redaction, disabled/shared-key configuration and AbortSignal propagation.
