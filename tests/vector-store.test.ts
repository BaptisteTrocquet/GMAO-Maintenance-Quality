import { describe, expect, it, vi } from "vitest";
import {
  createDisabledVectorStoreAdapter,
  ScopedVectorStore,
  type VectorStoreAdapter,
  type VectorStoreAdapterDeleteInput,
  type VectorStoreAdapterQueryInput,
  type VectorStoreAdapterUpsertInput,
  type VectorStoreQueryHit,
} from "@/lib/ai/vector-store";

function adapter(overrides: Partial<VectorStoreAdapter> = {}): VectorStoreAdapter {
  return {
    id: "test-vector-store",
    displayName: "Test Vector Store",
    enabled: true,
    upsert: vi.fn(async (input: VectorStoreAdapterUpsertInput) => ({ upserted: input.records.length })),
    delete: vi.fn(async (input: VectorStoreAdapterDeleteInput) => ({ deleted: input.ids.length })),
    query: vi.fn(async (input: VectorStoreAdapterQueryInput): Promise<VectorStoreQueryHit[]> => [
      {
        id: "chunk-1",
        score: 0.97,
        organizationId: input.scope.organizationId,
        siteId: input.scope.siteId,
        metadata: { documentId: "doc-1", revisionId: "rev-1", chunkIndex: 0 },
      },
    ]),
    ...overrides,
  };
}

const scope = { organizationId: "org-a", siteId: "site-a" };

const record = {
  id: "chunk-1",
  vector: [0.1, 0.2, 0.3],
  metadata: { documentId: "doc-1", revisionId: "rev-1", chunkIndex: 0 },
};

describe("tenant-safe vector store abstraction", () => {
  it("passes exact tenant scope into upsert, query and delete", async () => {
    const backend = adapter();
    const store = new ScopedVectorStore(backend);

    await expect(
      store.upsert({ scope, namespace: "effective-documents", dimensions: 3, records: [record] }),
    ).resolves.toEqual({ upserted: 1 });

    const hits = await store.query({
      scope,
      namespace: "effective-documents",
      dimensions: 3,
      vector: [0.3, 0.2, 0.1],
      limit: 5,
      filter: { documentType: "SOP" },
    });

    await expect(
      store.delete({ scope, namespace: "effective-documents", ids: ["chunk-1"] }),
    ).resolves.toEqual({ deleted: 1 });

    expect(backend.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        records: [expect.objectContaining({ id: "chunk-1", vector: [0.1, 0.2, 0.3] })],
        signal: expect.any(AbortSignal),
      }),
    );
    expect(backend.query).toHaveBeenCalledWith(
      expect.objectContaining({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        vector: [0.3, 0.2, 0.1],
        limit: 5,
        filter: { documentType: "SOP" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(hits).toEqual([
      {
        id: "chunk-1",
        score: 0.97,
        organizationId: "org-a",
        siteId: "site-a",
        metadata: { documentId: "doc-1", revisionId: "rev-1", chunkIndex: 0 },
      },
    ]);
  });

  it("fails closed if a backend returns a hit from another organization", async () => {
    const backend = adapter({
      query: vi.fn(async (): Promise<VectorStoreQueryHit[]> => [
        {
          id: "foreign",
          score: 0.99,
          organizationId: "org-b",
          siteId: "site-a",
          metadata: { documentId: "secret-doc" },
        },
      ]),
    });
    const store = new ScopedVectorStore(backend);

    await expect(
      store.query({ scope, namespace: "effective-documents", dimensions: 3, vector: [1, 0, 0] }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });
  });

  it("fails closed if a backend returns a hit from another site", async () => {
    const backend = adapter({
      query: vi.fn(async (): Promise<VectorStoreQueryHit[]> => [
        {
          id: "foreign-site",
          score: 0.99,
          organizationId: "org-a",
          siteId: "site-b",
          metadata: { documentId: "other-site-doc" },
        },
      ]),
    });
    const store = new ScopedVectorStore(backend);

    await expect(
      store.query({ scope, namespace: "effective-documents", dimensions: 3, vector: [1, 0, 0] }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });
  });

  it("treats organization-level scope as exact null-site scope", async () => {
    const backend = adapter({
      query: vi.fn(async (): Promise<VectorStoreQueryHit[]> => [
        {
          id: "site-specific",
          score: 0.8,
          organizationId: "org-a",
          siteId: "site-a",
          metadata: { documentId: "doc-1" },
        },
      ]),
    });
    const store = new ScopedVectorStore(backend);

    await expect(
      store.query({
        scope: { organizationId: "org-a", siteId: null },
        namespace: "effective-documents",
        dimensions: 3,
        vector: [1, 0, 0],
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });
  });

  it("rejects malformed vectors and duplicate ids before backend access", async () => {
    const backend = adapter();
    const store = new ScopedVectorStore(backend);

    await expect(
      store.upsert({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        records: [{ ...record, vector: [1, 2] }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      store.upsert({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        records: [record, { ...record }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      store.query({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        vector: [1, Number.NaN, 3],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(backend.upsert).not.toHaveBeenCalled();
    expect(backend.query).not.toHaveBeenCalled();
  });

  it("rejects credential-like and non-scalar metadata", async () => {
    const backend = adapter();
    const store = new ScopedVectorStore(backend);

    await expect(
      store.upsert({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        records: [{ ...record, metadata: { apiKey: "must-not-persist" } }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await expect(
      store.query({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        vector: [1, 0, 0],
        filter: { nested: { unsafe: true } } as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(backend.upsert).not.toHaveBeenCalled();
    expect(backend.query).not.toHaveBeenCalled();
  });

  it("rejects malformed backend result sets and metadata", async () => {
    const duplicateHits = adapter({
      query: vi.fn(async (): Promise<VectorStoreQueryHit[]> => [
        {
          id: "same",
          score: 0.9,
          organizationId: "org-a",
          siteId: "site-a",
          metadata: {},
        },
        {
          id: "same",
          score: 0.8,
          organizationId: "org-a",
          siteId: "site-a",
          metadata: {},
        },
      ]),
    });
    await expect(
      new ScopedVectorStore(duplicateHits).query({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        vector: [1, 0, 0],
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const unsafeMetadata = adapter({
      query: vi.fn(async (): Promise<VectorStoreQueryHit[]> => [
        {
          id: "chunk-1",
          score: 0.9,
          organizationId: "org-a",
          siteId: "site-a",
          metadata: { accessToken: "leak" },
        },
      ]),
    });
    await expect(
      new ScopedVectorStore(unsafeMetadata).query({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        vector: [1, 0, 0],
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("redacts backend errors instead of surfacing credentials or provider diagnostics", async () => {
    const backend = adapter({
      query: vi.fn(async () => {
        throw new Error("backend password=vector-secret private diagnostic");
      }),
    });
    const store = new ScopedVectorStore(backend);

    let caught: unknown;
    try {
      await store.query({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        vector: [1, 0, 0],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "STORE_ERROR" });
    expect(String(caught)).not.toContain("vector-secret");
    expect(String(caught)).not.toContain("private diagnostic");
  });

  it("enforces deadline and caller cancellation", async () => {
    const hanging = adapter({
      query: vi.fn(() => new Promise<VectorStoreQueryHit[]>(() => undefined)),
    });
    const store = new ScopedVectorStore(hanging);
    await expect(
      store.query({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        vector: [1, 0, 0],
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    const controller = new AbortController();
    controller.abort();
    const backend = adapter();
    const cancelled = new ScopedVectorStore(backend);
    await expect(
      cancelled.query({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        vector: [1, 0, 0],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(backend.query).not.toHaveBeenCalled();
  });

  it("fails closed when the vector store is disabled", async () => {
    const backend = createDisabledVectorStoreAdapter();
    const spy = vi.spyOn(backend, "query");
    const store = new ScopedVectorStore(backend);

    await expect(
      store.query({
        scope,
        namespace: "effective-documents",
        dimensions: 3,
        vector: [1, 0, 0],
      }),
    ).rejects.toMatchObject({ code: "STORE_DISABLED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not expose backend-specific configuration through metadata", () => {
    const backend = Object.assign(adapter(), {
      apiKey: "vector-secret",
      endpoint: "https://private-vector.example.test",
    });
    const metadata = new ScopedVectorStore(backend).metadata();

    expect(metadata).toEqual({
      id: "test-vector-store",
      displayName: "Test Vector Store",
      enabled: true,
    });
    expect(JSON.stringify(metadata)).not.toContain("vector-secret");
    expect(JSON.stringify(metadata)).not.toContain("private-vector.example.test");
  });
});
