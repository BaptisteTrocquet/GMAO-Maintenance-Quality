# Controlled-document semantic search

Controlled-document semantic search is an optional AI retrieval capability for **currently `EFFECTIVE` controlled document revisions only**. It is exposed through an authenticated server runtime while preserving the authorization-before-retrieval, tenant isolation and PostgreSQL source revalidation enforced by the underlying domain service.

Core controlled-document workflows do not depend on an embedding provider or vector store being available.

## Runtime API

The application exposes a read-only endpoint:

```text
POST /api/ai/documents/search
```

Request body:

```json
{
  "organizationId": "org-id",
  "query": "pump bearing replacement",
  "limit": 10
}
```

`limit` is optional and bounded to 1–25.

The payload is strict. Callers cannot choose the embedding provider, embedding model, vector dimensions, vector namespace or vector-store implementation. Those remain operator-controlled server configuration.

Authentication is completed before the semantic-search runtime is composed. The domain service then performs `document:read` authorization before any embedding, vector-store or PostgreSQL retrieval operation.

## Server runtime

The default server composition uses:

- the OpenAI embedding adapter under the fixed `openai` provider ID;
- `OPENAI_EMBEDDING_MODEL` as the operator-selected embedding model;
- optional `OPENAI_EMBEDDING_DIMENSIONS` when supported by the selected model;
- `OPENAI_API_KEY` only on the server;
- the native PostgreSQL vector store;
- the fixed controlled-document namespace owned by the domain service.

None of these controls are accepted from the browser/API payload. If no embedding model is configured, the provider is deliberately registered in disabled mode rather than making controlled-document functionality unavailable.

## Authorization boundary

`createControlledDocumentSemanticSearch()` requires a `ControlledDocumentAuthorization` containing organization membership scope and actor identity. It calls `assertPermission(...)` **before any database lookup, controlled-file read, embedding call, or vector-store call**:

- searching requires `document:read`;
- indexing requires `document:manage`.

The authenticated runtime API only exposes search. Administrative indexing remains separate.

## Tenant isolation

Controlled documents are organization-scoped, so semantic-search vectors use the exact scope:

```text
{ organizationId, siteId: null }
```

`siteId: null` is an exact organization-level scope, not a wildcard. The `ScopedVectorStore` independently rejects cross-organization or cross-site hits, and the API caller cannot override the namespace.

After vector retrieval, every candidate is reloaded from PostgreSQL before it can be returned. A result is retained only when:

- the document belongs to the authorized organization;
- the revision is still `EFFECTIVE`;
- `effectiveAt` has been reached;
- `expiresAt` has not been reached when present;
- vector metadata document/revision identity matches PostgreSQL;
- the indexed checksum still matches when a checksum is present.

Stale, obsolete, expired, foreign-tenant or checksum-mismatched candidates are discarded. The vector index is never authoritative for document status or ownership.

## Indexing

`indexEffectiveRevision()` verifies the current revision state before reading the controlled file. The production file reader remains `readDocumentRevisionFile()`, preserving the existing SHA-256 integrity check before text is embedded.

The built-in extractor intentionally supports only strict UTF-8 text formats:

- `text/plain`
- `text/markdown`
- `text/csv`
- `text/xml`
- `application/json`
- `application/xml`

Binary formats such as PDF are rejected rather than silently OCRed or parsed. A future extractor can be introduced as a separate, testable dependency without weakening authorization or tenant boundaries.

One vector is stored per effective revision. Indexed metadata stays deliberately minimal:

- `documentId`
- `revisionId`
- `checksum`

Storage keys, file paths, raw document contents, actor details, credentials and approval comments are not copied into vector metadata.

## Search results and source identity

The vector store only ranks candidate revisions. PostgreSQL remains the authority for whether a result is currently usable. Returned results retain stable controlled-document provenance:

- document ID/code/title;
- revision ID/revision label;
- effective date;
- controlled-file checksum;
- document UI path;
- vector similarity score.

Embedding vectors and provider credentials are never returned to the caller.

## Stale vectors

When a revision is superseded, an older vector may remain in the backend until cleanup removes it. This remains safe because every search revalidates current revision state in PostgreSQL and refuses obsolete revisions. Oversampling allows valid current documents to survive filtering of stale candidates.

## Embedding provider fallback

The server runtime uses the same availability contract as the optional LLM features. Embedding-provider availability failures become structured `unavailable` data:

- `AI_DISABLED` — provider deliberately disabled;
- `AI_NOT_CONFIGURED` — selected provider absent;
- `AI_TEMPORARILY_UNAVAILABLE` — provider timeout/error/invalid response that may be retried.

These states do not weaken document authorization and do not break ordinary controlled-document APIs.

Only provider availability failures are converted to fallback. Invalid requests, authorization failures, tenant/vector metadata integrity failures and runtime configuration errors remain errors and fail closed.

## Indexing remains separate

The runtime API intentionally exposes **read-only search only**. `indexEffectiveRevision()` remains a server/domain operation requiring `document:manage`.

A future indexing/operations story can decide how ingestion jobs are scheduled, retried and observed without coupling that mutation surface to end-user search.

## Failure handling

The HTTP route returns bounded, redacted errors for denied access, invalid search requests, invalid vector/search context, invalid server AI configuration and unexpected runtime failures. Provider, database, vector-store and tenant diagnostics are not echoed to callers.
