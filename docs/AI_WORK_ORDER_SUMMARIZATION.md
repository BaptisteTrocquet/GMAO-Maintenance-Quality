# Work-order summarization

E13 provides a provider-neutral server-side work-order summarization boundary without making core maintenance workflows depend on AI.

## Purpose

`createWorkOrderSummarizer()` turns one authorized work order into a concise maintenance handoff using the existing `LlmProviderRegistry`.

The service deliberately summarizes structured operational facts only. It is not a generic dump of the work-order database row.

## Authorization boundary

The caller supplies an explicit authorization context:

- `organizationId`
- `siteId`
- `actorId`
- membership scope

The service requires both `work:read` and `asset:read` for the requested site before the first repository or model call.

The default repository then constrains the query by:

- work-order ID
- site ID
- active site
- site organization ID

Custom repository implementations are not trusted. Returned records are revalidated before the LLM is invoked. The service fails closed if the work order, linked asset, consumed part, or linked controlled document is outside the authorized organization/site relationships.

## Model context allowlist

The model receives only explicitly selected fields.

Work-order facts:

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

All collections are bounded by the repository query so a single work order cannot create an unbounded prompt.

## Explicitly excluded fields

This story intentionally does **not** send the following to the model:

- requester or assignee identities
- team/user identities
- work-order description
- completion note
- checklist notes
- attachment names/content
- storage keys or paths
- audit events or audit payloads
- warehouse/bin identifiers
- supplier information
- unit costs or other cost data

Those omissions are deliberate. E13 still has a separate sensitive-field policy story/check, so richer free-form or identity-bearing fields must not be introduced ad hoc.

## Prompt-injection boundary

Work-order titles, checklist labels, part names, document titles and all other retrieved values are treated as untrusted data.

The fixed system instruction tells the model to ignore instructions embedded in record values. Retrieved values are serialized only in the user-context message and never interpolated into the system instruction.

This is a defense-in-depth boundary, not permission to include arbitrary untrusted fields later.

## Provenance

The result returns deterministic source records for:

- `/maintenance/{workOrderId}`
- the linked `/assets/{assetId}`, when present
- linked `/documents/{documentId}` records

This provenance is intentionally separate from the later E13 story that will enforce citations inside AI answers. Returning sources here does not by itself satisfy the mandatory answer-citation check.

## Provider independence and failure behavior

The summarizer depends only on `LlmProviderRegistry`. It does not import a vendor SDK, API key, endpoint, or provider-specific response type.

Provider-disabled graceful fallback remains a separate E13 story. Until that story is implemented, provider errors propagate through the generic LLM abstraction and normal non-AI maintenance workflows remain unaffected.
