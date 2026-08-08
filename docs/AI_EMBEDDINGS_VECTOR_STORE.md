# Embeddings and vector-store abstraction

OpenGMAO keeps embedding generation and vector persistence behind provider-neutral server-side contracts. No vendor SDK or external vector database is required by the core product.

The abstractions live in:

- `lib/ai/embedding-provider.ts`
- `lib/ai/vector-store.ts`

Repository-provided optional/durable adapters live in:

- `lib/ai/openai-embedding-provider.ts` — optional server-side OpenAI embeddings adapter;
- `lib/ai/postgres-vector-store.ts` — durable native PostgreSQL vector-store baseline.

OpenAI embedding configuration and transport safety are documented in `docs/AI_OPENAI_EMBEDDINGS.md`.

They remain deliberately separate from semantic-search policy. Controlled-document semantic search decides **which controlled effective documents may be retrieved** and authorizes the caller before embedding or vector-store access.

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

### Optional OpenAI adapter

`createOpenAiEmbeddingProviderFromEnv()` supplies the first repository-provided enabled embedding adapter when OpenAI embedding configuration is present. With no OpenAI embedding configuration it returns the normal disabled provider, so AI remains optional.

The adapter uses the fixed OpenAI `/v1/embeddings` endpoint, float encoding and stable response indexes to map vectors back to OpenGMAO input IDs. It does not expose a configurable provider URL; alternate/local providers should implement the same `EmbeddingProvider` interface instead of receiving an OpenAI API key through a mutable endpoint.

See `docs/AI_OPENAI_EMBEDDINGS.md` for environment variables, response limits and secret-handling details.

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

Features that need multiple authorized site scopes must query those scopes explicitly and merge results after authorization. `null` never means “all sites”.

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

## Repository baseline: native PostgreSQL

`createPostgresVectorStore()` provides a durable zero-extra-infrastructure backend using the same PostgreSQL instance as the application. `AiVectorRecord` persists:

- exact organization scope;
- exact site scope, with an internal empty scope key representing public `siteId: null` semantics;
- namespace and record identity;
- vector dimensions and native PostgreSQL `DOUBLE PRECISION[]` values;
- already-validated scalar JSON metadata.

Upserts are idempotent for the same organization/site/namespace/record identity. Deletes remain constrained to that same exact scope.

Queries load only records with the exact organization, exact site/null-site, namespace and dimension count, apply exact scalar metadata filters, calculate cosine similarity in application code, and sort deterministically by descending score then record ID.

### Bounded baseline, not a hidden scale claim

The native adapter intentionally has a bounded candidate scan (5,000 records by default, configurable up to 50,000 when constructing the adapter). If a single exact scope/namespace/dimension set exceeds the configured bound, the adapter fails closed and the public wrapper returns `STORE_ERROR` instead of loading an unbounded corpus into application memory.

This backend is intended for modest controlled-document corpora and deployments that value zero additional infrastructure. Large semantic-search installations should implement the same `VectorStoreAdapter` contract with pgvector, Qdrant, Pinecone, Weaviate, Elasticsearch/OpenSearch or another indexed vector engine. Application authorization, scope validation and semantic-search code do not need to change.

The repository still does not create embeddings automatically for every existing record or document. Indexing lifecycle, effective-revision selection, text extraction, authorization and citations are handled by controlled-document semantic search rather than by the persistence adapter.

## Tests

`tests/embedding-provider.test.ts` verifies the provider-neutral registry contract:

- tenant-scoped provider routing;
- model overrides and safe metadata;
- input bounds and unique IDs;
- fixed/returned dimension validation;
- non-finite vector rejection;
- provider error redaction;
- timeout/cancellation;
- disabled-provider behavior.

`tests/openai-embedding-provider.test.ts` verifies the optional OpenAI adapter without live network calls:

- disabled and partial environment configuration;
- batched request shape and fixed endpoint;
- response-index mapping to stable input IDs;
- optional dimensions;
- malformed response rejection;
- HTTP/API-key error redaction;
- response-size bounds;
- AbortSignal propagation.

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

`npm run test:vector-store:db` is the isolated PostgreSQL drill for the repository baseline. CI verifies persistence across adapter re-instantiation, deterministic cosine ranking, exact metadata filters, organization/site/null-site isolation, idempotent updates, deletion and the candidate-scan safety bound against disposable synthetic data.
