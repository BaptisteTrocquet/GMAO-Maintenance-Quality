# Embeddings and vector-store abstraction

OpenGMAO keeps embedding generation and vector persistence behind provider-neutral server-side contracts. No vendor SDK or vector database is required by the core product.

The abstractions live in:

- `lib/ai/embedding-provider.ts`
- `lib/ai/vector-store.ts`

They are deliberately separate from semantic-search policy. The next E13 story decides **which controlled effective documents may be retrieved** and must authorize the caller before embedding or vector-store access.

## Embedding provider

`EmbeddingProviderRegistry` mirrors the provider-independent approach used by the LLM registry but has an embedding-specific contract. A provider receives:

- explicit organization/site invocation context;
- a purpose and optional correlation/actor metadata;
- a model identifier;
- a bounded batch of stable input IDs and text;
- an `AbortSignal`.

The registry validates provider output before application code sees it:

- every requested input ID must be returned exactly once;
- vectors must all use the declared dimension;
- dimensions are bounded to 65,536;
- every vector component must be finite;
- a provider with fixed dimensions cannot silently change dimensions;
- provider exceptions are converted to a generic `PROVIDER_ERROR`;
- timeouts and caller cancellation have stable errors.

Inputs are bounded to 128 items, 100,000 characters per item and 500,000 text characters per batch. These are defensive application limits, not provider token limits.

Provider metadata is projected to safe fields only. Adapter-specific API keys, endpoints and diagnostics are never exposed by `list()` or `get()`.

As with the LLM contract, tenant context is **not authorization**. A caller must already be authenticated and authorized before text is sent to an embedding provider.

## Vector store

`ScopedVectorStore` wraps a `VectorStoreAdapter` and enforces a provider-independent contract for:

- `upsert`
- `query`
- `delete`

Every operation requires an explicit tenant scope:

```ts
{
  organizationId: "org-a",
  siteId: "site-a" // or null for an exact organization-level namespace
}
```

The scope is passed to the backend **and revalidated on every query hit**. A backend that accidentally or maliciously returns a record from another organization or site causes the entire query to fail with `TENANT_SCOPE_MISMATCH`.

This double validation is intentional: filtering only in a vendor query is not considered a sufficient tenant-isolation boundary.

### Exact site semantics

`siteId` is exact, not a wildcard:

- `siteId: "site-a"` accepts only `site-a` hits;
- `siteId: null` accepts only organization-level (`null`) hits.

Future features that need multiple authorized site scopes must query those scopes explicitly and merge results after authorization. `null` never means “all sites”.

## Vector and metadata safety

The wrapper validates:

- dimensions from 1 to 65,536;
- finite vector components only;
- unique record IDs per mutation/result set;
- bounded upserts, deletes and query result counts;
- flat scalar metadata only;
- at most 32 metadata keys and 16 KiB serialized metadata;
- no credential-like metadata keys such as `authorization`, `apiKey`, `password`, `secret` or `token`;
- finite query scores;
- backend mutation counts.

The adapter is not allowed to return vectors in search hits through this contract; application code receives only safe IDs, scores, scope and metadata.

Backend exceptions are converted to a generic `STORE_ERROR` so credentials or vendor diagnostics do not escape the abstraction. Operations have bounded deadlines and support caller cancellation.

## No backend selected yet

This story intentionally does not choose pgvector, Pinecone, Qdrant, Weaviate, Elasticsearch/OpenSearch or another vector backend. A later deployment can implement `VectorStoreAdapter` without changing semantic-search application code.

Likewise, this story does not create embeddings for existing records or documents. Indexing lifecycle, effective-revision selection, chunking, authorization and citations belong to the semantic-search story.

## Tests

`tests/embedding-provider.test.ts` verifies:

- tenant-scoped provider routing;
- model overrides and safe metadata;
- input bounds and unique IDs;
- fixed/returned dimension validation;
- non-finite vector rejection;
- provider error redaction;
- timeout/cancellation;
- disabled-provider behavior.

`tests/vector-store.test.ts` verifies:

- exact organization/site scope propagation;
- fail-closed cross-organization and cross-site results;
- exact `null` site semantics;
- vector and identity validation;
- credential-like metadata rejection;
- malformed backend result rejection;
- backend-error redaction;
- timeout/cancellation;
- disabled-store behavior;
- safe metadata projection.
