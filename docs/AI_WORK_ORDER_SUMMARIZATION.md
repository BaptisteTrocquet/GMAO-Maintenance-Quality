# Work-order summarization

OpenGMAO provides a provider-neutral server-side Work Order summarization capability and exposes it through an authenticated application API without making core maintenance workflows depend on AI.

## Runtime API

The application route is:

```text
POST /api/ai/work-orders/{workOrderId}/summary
```

Request body:

```json
{
  "organizationId": "org-id",
  "siteId": "site-id"
}
```

The request schema is strict. Clients cannot select a provider or model through this route. The active provider/model remains server-side deployment configuration (`OPENAI_LLM_MODEL` for the repository-provided OpenAI adapter).

The route authenticates the request before composing the AI runtime. An unauthenticated request therefore cannot invoke the provider. It then passes the authenticated actor and tenant membership scope into the existing resilient Work Order summarizer.

A successful generation is returned as normal API data with the existing summary, provider/model metadata, finish reason, token usage, Work Order identity and deterministic source records.

When AI is deliberately disabled, not configured, times out or has a provider-level failure, the existing resilient fallback is returned as normal API data, for example:

```json
{
  "status": "unavailable",
  "reason": "AI_DISABLED",
  "retryable": false,
  "message": "AI is disabled. Core maintenance data and workflows remain available."
}
```

Authorization, tenant-context, citation and audit failures are **not** converted to provider fallback. They remain request/server errors and are returned with bounded generic diagnostics.

## Server runtime composition

`lib/ai/server-runtime.ts` is the repository-provided server composition boundary. It registers `createOpenAiResponsesLlmProviderFromEnv()` in `LlmProviderRegistry` under provider ID `openai` and builds the resilient/audited Work Order summarizer.

With no `OPENAI_LLM_MODEL`, the registry contains the normal disabled provider. Invalid deployment configuration is wrapped as a safe runtime-configuration error rather than exposing the underlying secret/config diagnostic through the API.

The route intentionally composes the runtime only after `authenticateRequest()` succeeds.

## Authorization boundary

`createWorkOrderSummarizer()` receives an explicit authorization context:

- `organizationId`
- `siteId`
- `actorId`
- membership scope

The service requires both `work:read` and `asset:read` for the requested site before the first repository or model call.

The default repository then constrains the query by:

- Work Order ID
- site ID
- active site
- site organization ID

Custom repository implementations are not trusted. Returned records are revalidated before the LLM is invoked. The service fails closed if the Work Order, linked asset, consumed part, or linked controlled document is outside the authorized organization/site relationships.

## Model context allowlist

The model receives only explicitly selected fields.

Work Order facts:

- ID and number
- title
- type, status, priority
- requested/planned/due/started/completed timestamps
- downtime minutes
- labor minutes

Site facts:

- ID, code, name

Linked asset facts, when present:

- ID, code, name
- status
- criticality

Checklist facts:

- item ID
- label
- completed flag
- aggregate completed/total counts

Consumed-part facts:

- consumption ID
- quantity and timestamp
- part ID, SKU, name, unit

Linked controlled-document facts:

- document ID
- code
- title

All collections are bounded by the repository query so a single Work Order cannot create an unbounded prompt.

## Explicitly excluded fields

The summarizer intentionally does **not** send the following to the model:

- requester or assignee identities
- team/user identities
- Work Order description
- completion note
- checklist notes
- attachment names/content
- storage keys or paths
- audit events or audit payloads
- warehouse/bin identifiers
- supplier information
- unit costs or other cost data

Those omissions are enforced by the current AI sensitive-field policy and must not be expanded ad hoc.

## Prompt-injection boundary

Work Order titles, checklist labels, part names, document titles and all other retrieved values are treated as untrusted data.

The fixed system instruction tells the model to ignore instructions embedded in record values. Retrieved values are serialized only in the user-context message and never interpolated into the system instruction.

This is a defense-in-depth boundary, not permission to include arbitrary untrusted fields later.

## Provenance and citations

The result returns deterministic source records for:

- `/maintenance/{workOrderId}`
- the linked `/assets/{assetId}`, when present
- linked `/documents/{documentId}` records

The citation wrapper enforces the E13 answer-citation contract before a successful result reaches the resilient API surface. The audit wrapper records citation references and generation metadata without storing the prompt or answer text.

## Audit behavior

The production composition uses the Prisma AI audit sink. A successful summary writes `AI_SUMMARY_GENERATED`; auditable provider/citation failures write `AI_SUMMARY_FAILED` before fallback is considered.

Audit payloads include bounded metadata such as organization/site, provider/model, finish reason, token usage and source/citation references. Prompt text and generated answer text are not persisted in the AI audit payload.

An audit write failure is fail-closed and is not converted to `AI_TEMPORARILY_UNAVAILABLE`.

## Provider independence and failure behavior

The summarizer itself depends only on `LlmProviderRegistry`. It does not import a vendor SDK, API key, endpoint, or provider-specific response type.

The server runtime currently registers the optional repository OpenAI Responses adapter, but alternate/local providers can implement the same registry contract. Core non-AI Work Order APIs continue to work when the registered provider is disabled or unavailable.

See `docs/AI_PROVIDERS.md` and `docs/AI_OPENAI_RESPONSES.md` for provider configuration and transport details.
