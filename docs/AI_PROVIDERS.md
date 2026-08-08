# LLM provider abstraction

OpenGMAO treats AI as an optional capability. The core maintenance and quality workflows must not depend on one LLM vendor or on AI being available.

The provider-neutral contract lives in `lib/ai/llm-provider.ts`.

## Boundary

Application features call `LlmProviderRegistry.generate(...)`. Vendor adapters implement the `LlmProvider` interface behind that registry.

The abstraction deliberately does **not** contain:

- OpenAI, Anthropic, Azure, Google or local-model SDK code;
- provider API keys or endpoints;
- document retrieval;
- authorization decisions;
- prompt logging;
- persistence or audit events;
- retry policy or vendor-specific rate-limit handling.

Those concerns are separate boundaries. In particular, carrying `organizationId` and optional `siteId` in `LlmInvocationContext` does not authorize a request. A feature must authenticate and authorize the caller **before** retrieval and before `generate(...)` is invoked.

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
- timeout defaults to 20 seconds and is capped at 120 seconds.

These are defensive transport/application limits, not a substitute for provider token limits or the future sensitive-field policy.

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

The deadline is enforced with `Promise.race`, so a buggy adapter that ignores its `AbortSignal` cannot hold an application request indefinitely.

## Disabled provider

`createDisabledLlmProvider()` supplies an explicit provider entry that cannot generate. The registry rejects it with `PROVIDER_DISABLED` before its adapter method is called.

This gives later stories a stable way to represent deployments where AI is not configured. The E13 provider-disabled fallback story still needs to wire this state through user-facing workflows; this first story only defines the provider-level primitive.

## Example adapter

A future vendor adapter can be registered without changing application code:

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
      // Resolve server-side provider credentials here.
      // Call the provider using input.signal.
      // Never place credentials in returned metadata or diagnostics.
      return {
        text: "...",
        model: input.model,
        finishReason: "stop",
      };
    },
  },
]);
```

Vendor adapters should remain server-only and should apply the same secret-handling principles as the E12 connector credential boundary.

## Tests

`tests/llm-provider.test.ts` covers:

- provider registration and routing;
- default and overridden models;
- safe metadata projection;
- duplicate/malformed provider rejection;
- disabled-provider behavior;
- mandatory tenant context;
- prompt/output/temperature bounds;
- hard timeouts even for adapters that ignore abort;
- caller cancellation;
- provider-error redaction;
- response validation.
