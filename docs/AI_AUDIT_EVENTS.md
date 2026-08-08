# AI audit events

E13 AI answer surfaces use server-side audit events without storing prompts, generated text, controlled-document contents, user contact data, attachment/storage details, or provider error messages.

## Outward-facing composition

Use the audited wrappers for any user-facing AI answer path:

- `createAuditedAssetContextAssistant()`
- `createAuditedWorkOrderSummarizer()`
- `createAuditedTroubleshootingAdvisor()`

These wrappers compose the cited E13 surfaces, so a successful outward-facing result has both server-owned citations and a persisted audit event.

The lower-level uncited/cited services remain reusable application primitives for tests and composition, but they are not the final outward-facing integration boundary.

## Audit storage

The default `createPrismaAiAuditSink()` writes to the existing `AuditLog` table. No schema migration is required.

Entity linkage stays meaningful to existing GMAO audit history:

- asset-context answer: `entityType = Asset`, `action = AI_CONTEXT_ANSWERED`
- work-order summary: `entityType = WorkOrder`, `action = AI_SUMMARY_GENERATED`
- troubleshooting suggestion: `entityType = Asset`, `action = AI_TROUBLESHOOTING_SUGGESTED`

Provider/citation failures after an authorized entity context use the corresponding `*_FAILED` action.

## Safe payload

A successful audit payload contains only:

- schema version and AI surface;
- success/failure status;
- organization/site IDs;
- provider/model identity;
- finish reason;
- token usage when the provider supplied it;
- source/citation counts;
- source record IDs and exact controlled-document revision IDs when known.

The actor is stored in the existing `AuditLog.actorId` column instead of duplicated in JSON.

The audit payload intentionally excludes:

- question/symptom/prompt/messages;
- generated answer/summary/suggestion;
- document text or excerpts;
- citation labels and hrefs;
- requester/assignee/user data;
- emails/phone numbers;
- attachments/storage keys;
- audit snapshots;
- costs/supplier data;
- credentials, secrets, and tokens.

`assertAiAuditPayloadSafe()` is applied before every sink write as defense in depth.

## Failure behavior

Successful AI generation is fail-closed with respect to audit persistence. If the audit sink cannot persist the event, the wrapper throws `AiAuditError(AUDIT_WRITE_FAILED)` rather than returning an unaudited successful answer.

Known provider and citation failures are audited using stable error codes only. Provider exception messages are never copied into the audit payload.

Authorization failures, not-found results, and tenant/scope validation failures are not written as AI audit events. This prevents an unauthorized caller from creating audit noise for arbitrary resource IDs supplied in a request.

## Sensitive-field policy helper

`lib/ai/context-policy.ts` now defines reusable forbidden-field guards for prompt-context objects and stricter audit payloads. Existing E13 answer services already construct prompt context from explicit allowlists; the helper gives future AI context builders a shared regression guard instead of relying on convention alone.

The epic-wide mandatory sensitive-field check remains separate from this story until every outward-facing AI composition is explicitly covered by the policy boundary.

## Scope

This story does not introduce a vendor SDK, public AI route, new database table, or dependency from normal maintenance workflows to AI. Provider-disabled graceful fallback remains the final E13 story.