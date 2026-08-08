# AI source citations

E13 AI answer surfaces use server-owned citations. The model is never trusted to choose or invent provenance.

## Contract

`lib/ai/citations.ts` provides cited wrappers for the three current answer-producing services:

- `createCitedAssetContextAssistant()`
- `createCitedWorkOrderSummarizer()`
- `createCitedTroubleshootingAdvisor()`

The underlying feature services remain retrieval/generation primitives. Any outward-facing AI composition should use the cited wrappers.

Each cited result contains:

- the generated answer with a deterministic `Sources:` footer;
- the existing authorized `sources` array;
- a normalized `citations` array with a server-assigned marker, record type, stable record ID, optional document revision ID, display label, and internal UI path.

## Trust boundary

Citation markers are assigned after model generation. Model-authored `[S1]`-style markers are removed before the server appends its own markers. This prevents a provider from spoofing a record, document, or tenant provenance reference.

Every citation source is derived only from source objects already emitted by tenant-safe application services. The citation layer additionally validates that the internal UI path matches the source record identity:

- assets: `/assets/{assetId}`
- work orders: `/maintenance/{workOrderId}`
- controlled documents: `/documents/{documentId}`

A source route mismatch fails closed.

AI answers with no authorized sources also fail closed instead of returning uncited generated text.

## Document identity

Troubleshooting citations preserve the exact `revisionId` of the currently effective controlled document revision that was semantically retrieved, revalidated, re-read, and checksum-verified before generation.

Work-order summaries currently cite the linked controlled-document record because that surface only provides document-level metadata and does not retrieve a specific effective revision. The citation layer does not invent a revision that was not part of the authorized context.

## Sensitive data

The citation layer only uses stable IDs, display codes/titles already present in authorized source projections, revision IDs when actually known, and server-generated internal paths. It does not add storage keys, user identities, audit payloads, provider configuration, credentials, free-form notes, or document contents.

## Failure behavior

Citation formatting throws `AiCitationError` with stable codes for:

- `INVALID_ANSWER`
- `INVALID_SOURCE`
- `NO_SOURCES`

This is intentional: an uncited or provenance-invalid answer is not an acceptable successful AI answer.

## Scope

This story establishes source citations for all current E13 answer surfaces. AI audit events and provider-disabled graceful fallback remain separate stories.