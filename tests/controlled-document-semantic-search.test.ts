import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MembershipRole } from "@prisma/client";
import {
  EmbeddingProviderRegistry,
  type EmbeddingProvider,
} from "@/lib/ai/embedding-provider";
import {
  ScopedVectorStore,
  type VectorStoreAdapter,
  type VectorStoreQueryHit,
} from "@/lib/ai/vector-store";
import {
  ControlledDocumentSearchError,
  createControlledDocumentSemanticSearch,
  extractSearchableControlledDocumentText,
  type ControlledDocumentRevisionRecord,
  type ControlledDocumentSearchRepository,
} from "@/lib/ai/controlled-document-search";

const readDocumentRevisionFileMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/documents/files", () => ({
  readDocumentRevisionFile: readDocumentRevisionFileMock,
}));

const now = new Date("2026-08-08T10:00:00.000Z");

function membership(role: MembershipRole = "QUALITY_MANAGER", active = true) {
  return { active, role, allSites: false, siteIds: ["site-a"] } as const;
}

function authorization(role: MembershipRole = "QUALITY_MANAGER", active = true) {
  return {
    organizationId: "org-a",
    actorId: "user-a",
    scope: membership(role, active),
  };
}

function revision(overrides: Partial<ControlledDocumentRevisionRecord> = {}): ControlledDocumentRevisionRecord {
  return {
    id: "rev-1",
    revision: "A",
    status: "EFFECTIVE",
    effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: null,
    checksum: "checksum-a",
    fileName: "procedure.md",
    mimeType: "text/markdown",
    document: {
      id: "doc-1",
      organizationId: "org-a",
      code: "SOP-001",
      title: "Pump start-up procedure",
    },
    ...overrides,
  };
}

function repository(input?: {
  one?: ControlledDocumentRevisionRecord | null;
  many?: ControlledDocumentRevisionRecord[];
}) {
  return {
    findEffectiveRevision: vi.fn(async () => input?.one ?? revision()),
    findEffectiveRevisionsByIds: vi.fn(async () => input?.many ?? [revision()]),
  } satisfies ControlledDocumentSearchRepository;
}

function embeddingProvider() {
  const provider: EmbeddingProvider = {
    id: "test-embeddings",
    displayName: "Test embeddings",
    enabled: true,
    defaultModel: "test-embedding-v1",
    dimensions: 3,
    embed: vi.fn(async (input) => ({
      model: input.model,
      dimensions: 3,
      embeddings: input.inputs.map((item) => ({ id: item.id, vector: [0.1, 0.2, 0.3] })),
    })),
  };
  return provider;
}

function vectorAdapter(hits: VectorStoreQueryHit[] = []) {
  const adapter: VectorStoreAdapter = {
    id: "test-vector",
    displayName: "Test vector store",
    enabled: true,
    upsert: vi.fn(async (input) => ({ upserted: input.records.length })),
    delete: vi.fn(async (input) => ({ deleted: input.ids.length })),
    query: vi.fn(async () => hits),
  };
  return adapter;
}

function service(input?: {
  repo?: ControlledDocumentSearchRepository;
  hits?: VectorStoreQueryHit[];
}) {
  const provider = embeddingProvider();
  const adapter = vectorAdapter(input?.hits);
  const repo = input?.repo ?? repository();
  const instance = createControlledDocumentSemanticSearch({
    embeddingRegistry: new EmbeddingProviderRegistry([provider]),
    embeddingProviderId: provider.id,
    vectorStore: new ScopedVectorStore(adapter),
    repository: repo,
    now: () => now,
  });
  return { instance, provider, adapter, repo };
}

function hit(overrides: Partial<VectorStoreQueryHit> = {}): VectorStoreQueryHit {
  return {
    id: "rev-1",
    score: 0.92,
    organizationId: "org-a",
    siteId: null,
    metadata: {
      documentId: "doc-1",
      revisionId: "rev-1",
      checksum: "checksum-a",
    },
    ...overrides,
  };
}

describe("controlled document semantic search", () => {
  beforeEach(() => {
    readDocumentRevisionFileMock.mockReset();
  });

  it("authorizes before database, embedding, vector-store or storage calls", async () => {
    const { instance, provider, adapter, repo } = service({ hits: [hit()] });

    await expect(
      instance.search({
        authorization: authorization("VIEWER", false),
        query: "pump start",
      }),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });

    expect(provider.embed).not.toHaveBeenCalled();
    expect(adapter.query).not.toHaveBeenCalled();
    expect(repo.findEffectiveRevisionsByIds).not.toHaveBeenCalled();
    expect(readDocumentRevisionFileMock).not.toHaveBeenCalled();
  });

  it("embeds and queries only inside the exact organization-level vector scope", async () => {
    const { instance, provider, adapter } = service({ hits: [hit()] });

    const results = await instance.search({ authorization: authorization(), query: "pump start" });

    expect(provider.embed).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          organizationId: "org-a",
          siteId: null,
          actorId: "user-a",
          purpose: "controlled-document-semantic-search",
        }),
      }),
    );
    expect(adapter.query).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { organizationId: "org-a", siteId: null },
        namespace: "controlled-documents-v1",
      }),
    );
    expect(results).toHaveLength(1);
  });

  it("revalidates vector hits against current EFFECTIVE records before returning sources", async () => {
    const current = revision();
    const stale = revision({
      id: "rev-stale",
      status: "OBSOLETE",
      document: { ...revision().document, id: "doc-stale", code: "SOP-OLD" },
    });
    const foreign = revision({
      id: "rev-foreign",
      document: {
        ...revision().document,
        id: "doc-foreign",
        organizationId: "org-b",
        code: "SOP-FOREIGN",
      },
    });
    const repo = repository({ many: [current, stale, foreign] });
    const { instance } = service({
      repo,
      hits: [
        hit(),
        hit({
          id: "rev-stale",
          score: 0.9,
          metadata: { documentId: "doc-stale", revisionId: "rev-stale", checksum: "checksum-a" },
        }),
        hit({
          id: "rev-foreign",
          score: 0.88,
          metadata: {
            documentId: "doc-foreign",
            revisionId: "rev-foreign",
            checksum: "checksum-a",
          },
        }),
      ],
    });

    const results = await instance.search({ authorization: authorization(), query: "pump" });

    expect(results).toEqual([
      {
        score: 0.92,
        source: {
          type: "controlled-document",
          documentId: "doc-1",
          documentCode: "SOP-001",
          documentTitle: "Pump start-up procedure",
          revisionId: "rev-1",
          revision: "A",
          checksum: "checksum-a",
          effectiveAt: "2026-08-01T00:00:00.000Z",
          href: "/documents/doc-1",
        },
      },
    ]);
  });

  it("drops stale vector records when the controlled file checksum changed", async () => {
    const { instance } = service({
      hits: [hit({ metadata: { documentId: "doc-1", revisionId: "rev-1", checksum: "old" } })],
    });

    await expect(
      instance.search({ authorization: authorization(), query: "pump" }),
    ).resolves.toEqual([]);
  });

  it("indexes only a currently EFFECTIVE revision after manage authorization", async () => {
    readDocumentRevisionFileMock.mockResolvedValueOnce({
      data: new TextEncoder().encode("Lock out the pump before maintenance."),
      fileName: "procedure.md",
      mimeType: "text/markdown; charset=utf-8",
      checksum: "checksum-a",
      storageKey: "documents/org-a/doc-1/rev-1/checksum-a",
    });
    const { instance, provider, adapter } = service();

    const result = await instance.indexEffectiveRevision({
      authorization: authorization("QUALITY_MANAGER"),
      documentId: "doc-1",
      revisionId: "rev-1",
    });

    expect(readDocumentRevisionFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a", documentId: "doc-1", revisionId: "rev-1" }),
    );
    expect(provider.embed).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          organizationId: "org-a",
          siteId: null,
          purpose: "controlled-document-index",
          correlationId: "rev-1",
        }),
        inputs: [{ id: "rev-1", text: "Lock out the pump before maintenance." }],
      }),
    );
    expect(adapter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { organizationId: "org-a", siteId: null },
        records: [
          expect.objectContaining({
            id: "rev-1",
            metadata: {
              documentId: "doc-1",
              revisionId: "rev-1",
              checksum: "checksum-a",
            },
          }),
        ],
      }),
    );
    expect(JSON.stringify(vi.mocked(adapter.upsert).mock.calls[0]?.[0])).not.toContain("storageKey");
    expect(result).toEqual({
      documentId: "doc-1",
      revisionId: "rev-1",
      dimensions: 3,
      checksum: "checksum-a",
    });
  });

  it("never reads or embeds a non-effective revision", async () => {
    const repo = repository({ one: null });
    const { instance, provider, adapter } = service({ repo });

    await expect(
      instance.indexEffectiveRevision({
        authorization: authorization(),
        documentId: "doc-1",
        revisionId: "rev-draft",
      }),
    ).rejects.toMatchObject({ code: "REVISION_NOT_EFFECTIVE" });

    expect(readDocumentRevisionFileMock).not.toHaveBeenCalled();
    expect(provider.embed).not.toHaveBeenCalled();
    expect(adapter.upsert).not.toHaveBeenCalled();
  });

  it("supports strict UTF-8 text formats and rejects binary controlled files", () => {
    expect(
      extractSearchableControlledDocumentText({
        data: new TextEncoder().encode("  preventive maintenance  "),
        fileName: "pm.txt",
        mimeType: "text/plain; charset=utf-8",
        checksum: "sha",
      }),
    ).toBe("preventive maintenance");

    expect(() =>
      extractSearchableControlledDocumentText({
        data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        fileName: "procedure.pdf",
        mimeType: "application/pdf",
        checksum: "sha",
      }),
    ).toThrowError(expect.objectContaining({ code: "FILE_NOT_SEARCHABLE" }));
  });

  it("rejects malformed index hits rather than returning an untraceable source", async () => {
    const { instance } = service({
      hits: [hit({ metadata: { documentId: "doc-1" } })],
    });

    await expect(
      instance.search({ authorization: authorization(), query: "pump" }),
    ).rejects.toBeInstanceOf(ControlledDocumentSearchError);
  });
});
