# AI provider fallback and optional-core behavior

E13 AI features are optional application services. Normal asset, work-order, quality, inventory, and document workflows do not depend on an LLM provider.

## Outward-facing composition

`lib/ai/fallback.ts` is the recommended composition boundary for current answer-producing AI surfaces:

- `createResilientAssetContextAssistant()`
- `createResilientWorkOrderSummarizer()`
- `createResilientTroubleshootingAdvisor()`

Each wrapper composes the existing authorization/retrieval service, server-owned citations, and AI audit events, then exposes a discriminated result:

```ts
{ status: "generated", result: ... }
```

or:

```ts
{
  status: "unavailable",
  reason: "AI_DISABLED" | "AI_NOT_CONFIGURED" | "AI_TEMPORARILY_UNAVAILABLE",
  retryable: boolean,
  message: string
}
```

The unavailable message is server-owned and intentionally does not include provider exception details, credentials, prompts, retrieved records, document text, or model output.

## Failure classification

The fallback layer converts only availability-class provider failures:

- `PROVIDER_DISABLED` -> `AI_DISABLED`, not retryable;
- `PROVIDER_NOT_FOUND` -> `AI_NOT_CONFIGURED`, not retryable;
- `TIMEOUT`, `PROVIDER_ERROR`, `INVALID_RESPONSE` -> `AI_TEMPORARILY_UNAVAILABLE`, retryable.

It does **not** hide:

- invalid requests;
- access-control failures;
- tenant-scope or retrieved-context integrity failures;
- cancellation/abort signals;
- citation integrity failures;
- AI audit policy or persistence failures.

Those errors keep their existing fail-closed behavior.

## Audit behavior

The resilient wrappers sit outside the audited wrappers. This means a provider-disabled, missing, timeout, provider-error, or invalid-response attempt is first recorded through the safe AI audit contract and is only then converted to an unavailable UI/application state.

If the audit event cannot be safely persisted, the audit failure is returned instead of pretending that the AI request completed normally.

## Disabled provider behavior

A provider with `enabled: false` is never invoked. `LlmProviderRegistry` raises `PROVIDER_DISABLED` before the adapter's `generate()` method can run. The resilient boundary converts that audited failure into `AI_DISABLED`.

The current feature services may still perform their authorized data lookup before reaching the provider registry. This preserves the existing authorization and source-integrity boundary and avoids creating a second, divergent authorization implementation in the fallback layer. No model call occurs.

## Sensitive-field policy

`lib/ai/context-policy.ts` now protects both structured context policies and the final serialized outbound model messages.

`LlmProviderRegistry.generate()` runs the outbound sensitive-field gate immediately before provider invocation. Serialized object keys for identity/contact fields, requester/assignee/user IDs, attachments/storage keys, audit snapshots, completion/checklist notes, supplier/cost data, credentials/passwords/secrets/tokens, and related forbidden fields cause a generic `INVALID_REQUEST` before the provider adapter sees the messages.

This is defense in depth on top of the existing explicit field allowlists in the asset-context, work-order-summary, and troubleshooting builders.

## Core-product independence

No core maintenance route, mutation, database model, migration, or state transition imports or requires the resilient AI boundary. AI can be disabled, absent, or temporarily unavailable without disabling normal GMAO workflows. Consumers should render the unavailable state as an optional-feature notice and continue to expose the underlying maintenance records and actions normally.
