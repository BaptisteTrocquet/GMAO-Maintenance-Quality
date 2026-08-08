import { describe, expect, it, vi } from "vitest";
import type { MembershipScope } from "@/lib/access-control";
import {
  createDisabledEmbeddingProvider,
  EmbeddingProviderRegistry,
  type EmbeddingProvider,
  type EmbeddingProviderEmbedInput,
} from "@/lib/ai/embedding-provider";
import { createResilientControlledDocumentSemanticSearch } from "@/lib/ai/fallback";
import { createDisabledVectorStoreAdapter, ScopedVectorStore } from "@/lib/ai/vector-store";

function authorization() {
  const scope: MembershipScope = {
    role: "ADMIN",
    active: true,
    allSites: true,
    siteIds: [],
  };
  return { organizationId: "org-a", actorId: "user-a", scope };
}

function inertRepository() {
  return {
    findEffectiveRevision: vi.fn(async () => null),
    findEffectiveRevisionsByIds: vi.fn(async () => []),
  };
}

function inertVectorStore() {
  return new ScopedVectorStore(createDisabledVectorStoreAdapter());
}

describe("embedding provider fallback", () => {
  it("returns the shared disabled AI state before vector or database retrieval", async () => {
    const provider = createDisabledEmbeddingProvider({
      id: "test-embedding",
      displayName: "Test embeddings",
    });
    const repository = inertRepository();
    const semanticSearch = createResilientControlledDocumentSemanticSearch({
      embeddingRegistry: new EmbeddingProviderRegistry([provider]),
      embeddingProviderId: provider.id,
      vectorStore: inertVectorStore(),
      repository,
    });

    await expect(
      semanticSearch.search({ authorization: authorization(), query: "pump maintenance" }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "AI_DISABLED",
      retryable: false,
      message: "AI is disabled. Core maintenance data and workflows remain available.",
    });
    expect(repository.findEffectiveRevisionsByIds).not.toHaveBeenCalled();
  });

  it("returns not-configured when the selected embedding provider is absent", async () => {
    const semanticSearch = createResilientControlledDocumentSemanticSearch({
      embeddingRegistry: new EmbeddingProviderRegistry(),
      embeddingProviderId: "missing-embedding",
      vectorStore: inertVectorStore(),
      repository: inertRepository(),
    });

    await expect(
      semanticSearch.search({ authorization: authorization(), query: "pump maintenance" }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "AI_NOT_CONFIGURED",
      retryable: false,
    });
  });

  it("converts embedding provider failures to the retryable safe state", async () => {
    const embed = vi.fn(async (_input: EmbeddingProviderEmbedInput) => {
      throw new Error("provider transport diagnostic");
    });
    const provider: EmbeddingProvider = {
      id: "test-embedding",
      displayName: "Test embeddings",
      enabled: true,
      defaultModel: "test-model",
      dimensions: 3,
      embed,
    };
    const semanticSearch = createResilientControlledDocumentSemanticSearch({
      embeddingRegistry: new EmbeddingProviderRegistry([provider]),
      embeddingProviderId: provider.id,
      vectorStore: inertVectorStore(),
      repository: inertRepository(),
    });

    await expect(
      semanticSearch.search({ authorization: authorization(), query: "pump maintenance" }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "AI_TEMPORARILY_UNAVAILABLE",
      retryable: true,
    });
  });

  it("does not hide request or authorization errors as embedding fallback", async () => {
    const provider = createDisabledEmbeddingProvider({ id: "test-embedding" });
    const semanticSearch = createResilientControlledDocumentSemanticSearch({
      embeddingRegistry: new EmbeddingProviderRegistry([provider]),
      embeddingProviderId: provider.id,
      vectorStore: inertVectorStore(),
      repository: inertRepository(),
    });

    await expect(
      semanticSearch.search({ authorization: authorization(), query: "" }),
    ).rejects.toMatchObject({ name: "ControlledDocumentSearchError", code: "INVALID_REQUEST" });

    const deniedScope: MembershipScope = {
      role: "REQUESTER",
      active: true,
      allSites: false,
      siteIds: [],
    };
    await expect(
      semanticSearch.search({
        authorization: { organizationId: "org-a", actorId: "user-a", scope: deniedScope },
        query: "pump",
      }),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });
  });
});
