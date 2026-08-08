# Asset-context assistant

The asset-context assistant is an optional, provider-neutral AI capability exposed through an authenticated server runtime while keeping core asset and work-order workflows independent from any LLM.

The runtime composition uses the repository OpenAI Responses adapter when configured and preserves the existing provider-disabled / not-configured / temporarily-unavailable fallback states.

## Runtime API

The application exposes:

```text
POST /api/ai/assets/{assetId}/ask
```

Request body:

```json
{
  "organizationId": "org-id",
  "siteId": "site-id",
  "question": "What recent maintenance history should I know about?"
}
```

The payload is strict. Clients cannot provide a provider ID, model name or work-order context limit. Model selection stays operator-controlled through the server AI configuration (`OPENAI_LLM_MODEL`).

Authentication is completed before the server AI runtime is composed. The route then delegates authorization, tenant revalidation, context construction, citations, audit and provider fallback to the existing feature layers instead of duplicating them.

Generated answers and safe unavailable states are returned as normal API data. Access, tenant/context, audit and runtime-configuration failures fail closed with bounded error responses that do not expose provider, database or tenant diagnostics.

## Authorization boundary

`createAssetContextAssistant().ask()` requires an explicit authorization envelope:

- `organizationId`
- `siteId`
- `actorId`
- membership scope

Before any database retrieval or model invocation, the service requires both:

- `asset:read` for the requested site;
- `work:read` for the requested site.

The repository query is constrained by asset ID, site ID, active site, organization ID and non-archived asset state.

Even when a custom repository implementation is injected, the service revalidates that:

- the asset belongs to the authorized site;
- the asset site belongs to the authorized organization;
- the site is active;
- the asset is not archived;
- every recent work order belongs to the same authorized site and asset.

Any mismatch fails closed before the LLM provider is called.

## Model context allowlist

Prisma/database objects are never serialized directly into a model prompt.

The model receives only this structured allowlist.

### Asset

- asset ID
- code
- name
- category
- manufacturer
- model
- serial number
- lifecycle status
- criticality
- installed/commissioned/decommissioned dates
- site ID/code/name
- location ID/code/name

### Recent work orders

- work-order ID and number
- title
- type
- status
- priority
- requested/planned/due/started/completed dates
- downtime minutes
- labor minutes

The assistant deliberately does **not** send requester or assignee identities, attachment storage details, audit-log payloads, stock/supplier credentials, work-order descriptions or free-form completion notes.

## Prompt-injection boundary

Asset and work-order values are considered untrusted data. The fixed system instruction tells the model not to follow instructions embedded in record values and not to infer data outside the supplied context.

Record text is placed only in the user-side JSON context; it is never concatenated into the system instruction.

## Provider invocation

The LLM invocation carries the exact tenant context:

```text
organizationId = authorized organization
siteId         = authorized site
actorId        = authenticated actor
purpose        = asset-context-assistant
correlationId  = asset ID
```

The server runtime registers the OpenAI Responses provider under the fixed `openai` provider ID. Provider/model configuration is deployment-owned, not caller-owned.

## Citations and audit

The cited assistant layer validates the returned provenance against authorized asset/work-order sources before the audited layer records the AI event.

Successful calls persist an `AI_CONTEXT_ANSWERED` audit event for the asset, including safe provider/model/usage metadata and source/citation references. Auditable provider/citation failures produce `AI_CONTEXT_FAILED`. Audit persistence failures are never converted into an AI-unavailable fallback.

## Provider fallback

Only provider availability failures are converted into resilient states:

- `AI_DISABLED`
- `AI_NOT_CONFIGURED`
- `AI_TEMPORARILY_UNAVAILABLE`

Authorization, tenant-scope, context-integrity and audit failures remain errors and fail closed. This keeps the core product available without weakening the security boundary around AI retrieval.
