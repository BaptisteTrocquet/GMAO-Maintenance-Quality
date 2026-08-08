# Controlled-document semantic search

OpenGMAO semantic search is deliberately limited to **controlled document revisions that are currently `EFFECTIVE`**. This layer builds on the provider-neutral embedding and vector-store abstractions and does not make the core product dependent on a specific AI vendor.

## Authorization boundary

`createControlledDocumentSemanticSearch()` requires a `ControlledDocumentAuthorization` containing the organization membership scope and actor identity. The service calls `assertPermission(...)` **before any database lookup, controlled-file read, embedding call, or vector-store call**:

- searching requires `document:read`;
- indexing requires `document:manage`.

The organization ID comes from the already-authenticated tenant context supplied by the caller. Application/API routes must still obtain that context through the normal request-authentication flow; callers must never construct it from untrusted request fields without authentication.

## Tenant isolation

Controlled documents are organization-scoped in the existing data model, so semantic-search vectors use the exact vector scope:

```text
{ organizationId, siteId: null }
```

`siteId: null` is an exact organization-level scope, not a wildcard. The `ScopedVectorStore` independently rejects cross-organization or cross-site hits.

Semantic search adds a second boundary after vector retrieval: every hit is reloaded from PostgreSQL with all of the following constraints before it can be returned:

- document belongs to the authorized organization;
- revision is still `EFFECTIVE`;
- `effectiveAt` has been reached;
- `expiresAt` has not been reached when present;
- the vector metadata document ID matches the current database record;
- the indexed checksum matches the current controlled-file checksum when a checksum is present.

A stale, obsolete, foreign-tenant, mismatched, or unverifiable vector hit is discarded.

## Indexing

`indexEffectiveRevision()` verifies the current revision state before reading the controlled file. The production file reader remains `readDocumentRevisionFile()`, so the existing SHA-256 integrity check is preserved before text is embedded.

The built-in extractor intentionally supports only strict UTF-8 text formats:

- `text/plain`
- `text/markdown`
- `text/csv`
- `text/xml`
- `application/json`
- `application/xml`

Binary formats such as PDF are rejected rather than silently OCRed or parsed. A future extractor can be introduced as a separate, testable dependency without weakening the authorization or tenant boundaries.

One vector is stored per effective revision in this story. The indexed metadata is deliberately minimal:

- `documentId`
- `revisionId`
- `checksum`

Storage keys, file paths, raw document contents, actor details, credentials, approval comments, and other sensitive fields are not copied into vector metadata.

## Search results and source identity

The vector store is used only to rank candidate revisions. PostgreSQL remains the authority for whether a result is currently usable. Returned results contain a stable source object suitable for later citation features:

- document ID/code/title;
- revision ID/revision label;
- effective date;
- controlled-file checksum;
- document UI path;
- vector similarity score.

The later E13 source-citation story can consume these source objects without trusting vector metadata as the system of record.

## Stale vectors

When a revision is superseded, an older vector may remain in the backend until a cleanup process removes it. This is safe by design because search revalidates current revision state in PostgreSQL on every request and refuses obsolete revisions. Oversampling allows valid current documents to survive filtering of stale candidates.

## AI provider independence

This story does not add OpenAI, Anthropic, Pinecone, pgvector, or any other vendor-specific dependency. It composes:

- `EmbeddingProviderRegistry` for query/document embeddings;
- `ScopedVectorStore` for tenant-safe ranking;
- existing controlled-document storage and PostgreSQL records as authoritative sources.

If embeddings or the vector store are disabled, their existing provider-independent errors propagate. User-facing graceful fallback is intentionally handled by the later `Provider-disabled fallback behavior` story.
