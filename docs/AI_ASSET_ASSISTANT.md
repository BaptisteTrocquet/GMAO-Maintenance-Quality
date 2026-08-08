# Asset-context assistant

The asset-context assistant is an optional, provider-neutral server-side application service built on `LlmProviderRegistry`.

It does not make the core asset or work-order workflows depend on an LLM and does not configure a vendor-specific model endpoint.

## Authorization boundary

`createAssetContextAssistant().ask()` requires an explicit authorization envelope:

- `organizationId`
- `siteId`
- `actorId`
- membership scope

Before any database retrieval or model invocation, the service requires both:

- `asset:read` for the requested site;
- `work:read` for the requested site.

The repository query is then constrained by asset ID, site ID, active site, organization ID and non-archived asset state.

Even when a custom repository implementation is injected, the service revalidates that:

- the asset belongs to the authorized site;
- the asset site belongs to the authorized organization;
- the site is active;
- the asset is not archived;
- every recent work order belongs to the same authorized site and asset.

Any mismatch fails closed before the LLM provider is called.

## Model context allowlist

Prisma/database objects are never serialized directly into a model prompt.

The model receives only this structured allowlist:

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

The assistant deliberately does **not** send:

- requester or assignee identities;
- user IDs, names or email addresses from work-order relationships;
- attachment metadata or storage keys;
- audit-log payloads;
- stock, supplier or credential data;
- work-order descriptions or free-form completion notes.

This is intentionally narrower than future troubleshooting context. The later E13 sensitive-field policy must be applied before richer historical free text is added.

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

The generic LLM abstraction remains responsible for provider registration, model selection, timeouts, response validation and provider-error redaction.

## Provenance

The service returns a deterministic provenance manifest containing:

- the asset record/UI path;
- each work-order record/UI path included in the model context.

This story does not yet claim that generated prose cites those records inline. Enforced answer citations remain the dedicated E13 `Source citations in AI answers` story.

## Current integration scope

This story exposes a server-side application service rather than a public route because the repository still has no production vendor-specific LLM provider configuration. A later composition layer can wire the service to an authenticated UI/API once provider configuration and provider-disabled fallback behavior are defined.
