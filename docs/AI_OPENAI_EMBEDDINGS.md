# Optional OpenAI embeddings adapter

OpenGMAO keeps embeddings behind the provider-neutral `EmbeddingProvider` contract. `lib/ai/openai-embedding-provider.ts` provides an optional server-side OpenAI adapter so controlled-document semantic search can run without application code supplying a custom embedding implementation.

OpenAI remains optional. When the embedding model is not configured, `createOpenAiEmbeddingProviderFromEnv()` returns the existing disabled provider and core maintenance, Quality, document and planning workflows continue to operate without AI.

## Configuration

Configure an embedding model together with the shared server-side OpenAI API key:

```text
OPENAI_API_KEY=<server-side API key>
OPENAI_EMBEDDING_MODEL=<embedding model available to the deployment>
```

`OPENAI_EMBEDDING_MODEL` is the activation switch for this adapter. `OPENAI_API_KEY` may also be used by the optional OpenAI Responses LLM adapter and does **not** enable embeddings by itself.

The repository does not hard-code the active model because model availability is an operator/account choice. `.env.example` shows `text-embedding-3-small` as an example supported embedding model.

For embedding models that support selecting output dimensions, an optional override can be configured:

```text
OPENAI_EMBEDDING_DIMENSIONS=<positive integer>
```

A shared API key with no embedding model leaves the provider disabled. Embedding-specific partial configuration is rejected: a model requires the API key, and a dimensions override requires the embedding model.

`OPENAI_API_KEY` is secret material. It must stay in the deployment secret mechanism and must never be exposed through `NEXT_PUBLIC_*`, committed files, browser configuration, logs, provider metadata or error responses.

## HTTP boundary

The adapter calls only the fixed OpenAI embeddings endpoint:

```text
POST https://api.openai.com/v1/embeddings
```

The request uses bearer authentication and JSON with:

- the selected `model`;
- the normalized batch of input texts;
- `encoding_format: "float"`;
- optional `dimensions` when configured.

The endpoint is intentionally not configurable in this adapter. This prevents an OpenAI API key from being redirected to an arbitrary host through deployment configuration. Other providers or OpenAI-compatible endpoints should implement a separate `EmbeddingProvider` adapter instead of reusing the OpenAI credential with a mutable URL.

Redirects are rejected.

## Response safety

The OpenAI API identifies batch results using a numeric `index`. The adapter validates that indexes are unique, in range and complete, then maps each vector back to the stable OpenGMAO input ID at that index.

The adapter also verifies:

- successful HTTP status;
- JSON content type;
- a 16 MiB maximum response body;
- one vector per requested input;
- finite numeric vector elements;
- consistent dimensions across the batch;
- bounded model identifiers.

Provider response bodies are never surfaced in thrown public errors. The existing `EmbeddingProviderRegistry` converts adapter failures to its generic provider-error contract and independently revalidates vector counts, IDs, dimensions and finite values.

## Cancellation and timeouts

The adapter passes the registry-provided `AbortSignal` directly to `fetch`. The registry remains responsible for the provider-neutral deadline and caller-cancellation behavior.

## Semantic search composition

A configured application can compose:

- `createOpenAiEmbeddingProviderFromEnv()` in an `EmbeddingProviderRegistry`;
- `createPostgresVectorStore()` as the repository-provided durable vector baseline;
- `createControlledDocumentSemanticSearch()` for authorized indexing and retrieval of effective controlled document revisions.

The authorization boundary remains in the feature layer before embedding or vector-store access. Carrying organization/site context into the provider is not an authorization decision.

## Provider independence

This adapter does not change the E13 architecture. Deployments can register another `EmbeddingProvider` implementation for local models, Azure-hosted models or another service while keeping the same semantic-search and vector-store contracts.

CI uses a fake transport and never sends a live request or a real API key to OpenAI.
