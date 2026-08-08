# Optional OpenAI Responses LLM adapter

OpenGMAO keeps generative AI behind the provider-neutral `LlmProvider` contract. `lib/ai/openai-llm-provider.ts` provides an optional server-side OpenAI adapter for the existing work-order summary, asset-context assistant and authorized troubleshooting features.

OpenAI remains optional. When `OPENAI_LLM_MODEL` is not configured, `createOpenAiResponsesLlmProviderFromEnv()` returns the existing disabled provider and core maintenance, Quality, document, inventory and planning workflows continue without generative AI.

## Configuration

Set an operator-selected model together with the server-side OpenAI API key:

```text
OPENAI_API_KEY=<server-side API key>
OPENAI_LLM_MODEL=<model available to the deployment>
```

`OPENAI_LLM_MODEL` is the activation switch. `OPENAI_API_KEY` may be shared with the optional embedding adapter and does not enable the LLM adapter by itself.

The repository intentionally does not hard-code a generative model. Model availability, capability and cost are deployment choices and may change independently of OpenGMAO.

The API key is secret material. It must never be exposed through `NEXT_PUBLIC_*`, committed files, browser configuration, provider metadata, application logs or propagated upstream error bodies.

## Responses API boundary

The adapter calls only:

```text
POST https://api.openai.com/v1/responses
```

The endpoint is fixed rather than configurable so a deployment mistake cannot redirect an OpenAI API key to an arbitrary host. Alternate vendors, local models or OpenAI-compatible endpoints should implement a separate `LlmProvider` adapter.

Each request carries:

- the operator-selected model;
- the already-normalized `system`, `user` and `assistant` message sequence from the provider-neutral registry;
- `max_output_tokens`;
- optional `temperature` when the caller supplied one;
- `store: false`.

Redirects are rejected and the registry-provided `AbortSignal` is passed directly to the HTTP request.

`store: false` is intentional. OpenGMAO does not rely on provider-managed conversation state: every feature assembles its authorized context explicitly before the provider call.

## Response parsing

The adapter parses only assistant message output:

- `output_text` is concatenated into the provider-neutral text result;
- refusal content is returned as a safe refusal text and maps to `content_filter`;
- model `reasoning` output items are ignored and are never returned to OpenGMAO feature code;
- completed responses map to `stop`;
- incomplete responses caused by output-token exhaustion map to `length`;
- input/output token counts map to the provider-neutral usage fields.

Responses with failed/unknown status, invalid message content, no text/refusal output, malformed usage, non-JSON content or an oversized body fail through the registry's generic `PROVIDER_ERROR` boundary.

The HTTP response body is capped at 16 MiB. Non-success response bodies are never parsed into public error messages.

## Feature authorization

The adapter does not authorize the user and does not retrieve business data. Work-order summarization, asset assistant and troubleshooting already authenticate/authorize and apply the AI sensitive-field policy before the `LlmProviderRegistry` invokes the adapter.

Organization/site context in a provider call is therefore trace context, not an authorization substitute.

## Capabilities

This baseline advertises:

- streaming: false
- structured output: false
- tool calling: false

Those capabilities are deliberately conservative because the current OpenGMAO feature contract expects bounded text generation only. Future tool/structured-output work should extend the provider-neutral contract explicitly rather than silently enabling vendor-specific behavior.

## Tests

`tests/openai-llm-provider.test.ts` uses a fake transport only. It verifies the fixed endpoint, `store: false`, message mapping, output/usage parsing, incomplete/refusal finish reasons, reasoning exclusion, response-size bounds, API-key/upstream-body redaction, disabled configuration and AbortSignal propagation.

CI never makes a live OpenAI request and never requires a real API key.
