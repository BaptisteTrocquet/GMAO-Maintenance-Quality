import { assertPermission, type MembershipScope } from "@/lib/access-control";
import {
  EmbeddingProviderRegistry,
  type EmbeddingInvocationContext,
} from "@/lib/ai/embedding-provider";
import { ScopedVectorStore, type VectorStoreQueryHit } from "@/lib/ai/vector-store";
import { db } from "@/lib/db";
import { readDocumentRevisionFile } from "@/lib/documents/files";
import type { StorageAdapter } from "@/lib/storage";

const DEFAULT_NAMESPACE = "controlled-documents-v1";
const MAX_QUERY_CHARS = 4_000;
const MAX_INDEX_TEXT_CHARS = 100_000;
const MAX_RESULTS = 25;
const SEARCH_OVERSAMPLE = 4;

const SEARCHABLE_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/xml",
  "application/json",
  "application/xml",
]);

export type ControlledDocumentAuthorization = {
  organizationId: string;
  actorId: string;
  scope: MembershipScope;
};

export type ControlledDocumentSearchSource = {
  type: "controlled-document";
  documentId: string;
  documentCode: string;
  documentTitle: string;
  revisionId: string;
  revision: string;
  checksum: string | null;
  effectiveAt: string;
  href: string;
};

export type ControlledDocumentSearchResult = {
  score: number;
  source: ControlledDocumentSearchSource;
};

export type ControlledDocumentRevisionRecord = {
  id: string;
  revision: string;
  status: string;
  effectiveAt: Date | null;
  expiresAt: Date | null;
  checksum: string | null;
  fileName: string | null;
  mimeType: string | null;
  document: {
    id: string;
    organizationId: string;
    code: string;
    title: string;
  };
};

export interface ControlledDocumentSearchRepository {
  findEffectiveRevision(input: {
    organizationId: string;
    documentId: string;
    revisionId: string;
    asOf: Date;
  }): Promise<ControlledDocumentRevisionRecord | null>;
  findEffectiveRevisionsByIds(input: {
    organizationId: string;
    revisionIds: readonly string[];
    asOf: Date;
  }): Promise<ControlledDocumentRevisionRecord[]>;
}

export type ControlledDocumentFile = {
  data: Uint8Array;
  fileName: string;
  mimeType: string;
  checksum: string;
};

export type ControlledDocumentTextExtractor = (input: ControlledDocumentFile) => Promise<string> | string;

export class ControlledDocumentSearchError extends Error {
  constructor(
    public readonly code:
      | "INVALID_REQUEST"
      | "REVISION_NOT_EFFECTIVE"
      | "FILE_NOT_SEARCHABLE"
      | "CONTENT_TOO_LARGE"
      | "INVALID_INDEX_METADATA",
    message: string,
  ) {
    super(message);
    this.name = "ControlledDocumentSearchError";
  }
}

function normalizeOrganizationId(value: string) {
  const organizationId = value.trim();
  if (!organizationId || organizationId.length > 200 || /[\u0000\r\n]/.test(organizationId)) {
    throw new ControlledDocumentSearchError("INVALID_REQUEST", "Organization id is invalid");
  }
  return organizationId;
}

function normalizeActorId(value: string) {
  const actorId = value.trim();
  if (!actorId || actorId.length > 200 || /[\u0000\r\n]/.test(actorId)) {
    throw new ControlledDocumentSearchError("INVALID_REQUEST", "Actor id is invalid");
  }
  return actorId;
}

function authorize(
  authorization: ControlledDocumentAuthorization,
  permission: "document:read" | "document:manage",
) {
  // This intentionally happens before any database, storage, embedding, or vector-store call.
  assertPermission(authorization.scope, permission);
  return Object.freeze({
    organizationId: normalizeOrganizationId(authorization.organizationId),
    actorId: normalizeActorId(authorization.actorId),
  });
}

function normalizeQuery(value: string) {
  if (typeof value !== "string") {
    throw new ControlledDocumentSearchError("INVALID_REQUEST", "Search query is required");
  }
  const query = value.trim();
  if (!query || query.length > MAX_QUERY_CHARS || /\u0000/.test(query)) {
    throw new ControlledDocumentSearchError(
      "INVALID_REQUEST",
      `Search query must contain between 1 and ${MAX_QUERY_CHARS} characters`,
    );
  }
  return query;
}

function normalizeLimit(value: number | undefined) {
  const limit = value ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new ControlledDocumentSearchError(
      "INVALID_REQUEST",
      `Search limit must be between 1 and ${MAX_RESULTS}`,
    );
  }
  return limit;
}

function normalizeId(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000\r\n]/.test(normalized)) {
    throw new ControlledDocumentSearchError("INVALID_REQUEST", `${label} is invalid`);
  }
  return normalized;
}

function isEffectiveAt(record: ControlledDocumentRevisionRecord, asOf: Date) {
  return (
    record.status === "EFFECTIVE" &&
    record.effectiveAt !== null &&
    record.effectiveAt <= asOf &&
    (record.expiresAt === null || record.expiresAt > asOf)
  );
}

function normalizeMimeType(value: string) {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

export function extractSearchableControlledDocumentText(input: ControlledDocumentFile) {
  const mimeType = normalizeMimeType(input.mimeType);
  if (!SEARCHABLE_MIME_TYPES.has(mimeType)) {
    throw new ControlledDocumentSearchError(
      "FILE_NOT_SEARCHABLE",
      "Controlled document file type is not supported by the built-in text extractor",
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.data).trim();
  } catch {
    throw new ControlledDocumentSearchError(
      "FILE_NOT_SEARCHABLE",
      "Controlled document file is not valid UTF-8 text",
    );
  }
  if (!text) {
    throw new ControlledDocumentSearchError(
      "FILE_NOT_SEARCHABLE",
      "Controlled document file contains no searchable text",
    );
  }
  if (text.length > MAX_INDEX_TEXT_CHARS) {
    throw new ControlledDocumentSearchError(
      "CONTENT_TOO_LARGE",
      `Searchable controlled document text cannot exceed ${MAX_INDEX_TEXT_CHARS} characters`,
    );
  }
  return text;
}

function parseIndexHit(hit: VectorStoreQueryHit) {
  const revisionId = typeof hit.metadata.revisionId === "string" ? hit.metadata.revisionId : "";
  const documentId = typeof hit.metadata.documentId === "string" ? hit.metadata.documentId : "";
  const checksum = typeof hit.metadata.checksum === "string" ? hit.metadata.checksum : null;

  if (!revisionId || !documentId) {
    throw new ControlledDocumentSearchError(
      "INVALID_INDEX_METADATA",
      "Controlled document vector result is missing source identity",
    );
  }
  return { revisionId, documentId, checksum };
}

function defaultRepository(): ControlledDocumentSearchRepository {
  const select = {
    id: true,
    revision: true,
    status: true,
    effectiveAt: true,
    expiresAt: true,
    checksum: true,
    fileName: true,
    mimeType: true,
    document: {
      select: {
        id: true,
        organizationId: true,
        code: true,
        title: true,
      },
    },
  } as const;

  return {
    async findEffectiveRevision(input) {
      return db.documentRevision.findFirst({
        where: {
          id: input.revisionId,
          documentId: input.documentId,
          status: "EFFECTIVE",
          effectiveAt: { lte: input.asOf },
          OR: [{ expiresAt: null }, { expiresAt: { gt: input.asOf } }],
          document: { organizationId: input.organizationId },
        },
        select,
      });
    },
    async findEffectiveRevisionsByIds(input) {
      if (input.revisionIds.length === 0) return [];
      return db.documentRevision.findMany({
        where: {
          id: { in: [...input.revisionIds] },
          status: "EFFECTIVE",
          effectiveAt: { lte: input.asOf },
          OR: [{ expiresAt: null }, { expiresAt: { gt: input.asOf } }],
          document: { organizationId: input.organizationId },
        },
        select,
      });
    },
  };
}

export function createControlledDocumentSemanticSearch(input: {
  embeddingRegistry: EmbeddingProviderRegistry;
  embeddingProviderId: string;
  vectorStore: ScopedVectorStore;
  repository?: ControlledDocumentSearchRepository;
  storageAdapter?: StorageAdapter;
  textExtractor?: ControlledDocumentTextExtractor;
  namespace?: string;
  now?: () => Date;
}) {
  const repository = input.repository ?? defaultRepository();
  const extractor = input.textExtractor ?? extractSearchableControlledDocumentText;
  const namespace = input.namespace ?? DEFAULT_NAMESPACE;
  const now = input.now ?? (() => new Date());

  async function readFile(source: {
    organizationId: string;
    documentId: string;
    revisionId: string;
  }): Promise<ControlledDocumentFile> {
    return readDocumentRevisionFile({
      ...source,
      adapter: input.storageAdapter,
    });
  }

  return {
    async indexEffectiveRevision(args: {
      authorization: ControlledDocumentAuthorization;
      documentId: string;
      revisionId: string;
    }) {
      const authorization = authorize(args.authorization, "document:manage");
      const documentId = normalizeId(args.documentId, "Document id");
      const revisionId = normalizeId(args.revisionId, "Revision id");
      const asOf = now();

      const revision = await repository.findEffectiveRevision({
        organizationId: authorization.organizationId,
        documentId,
        revisionId,
        asOf,
      });
      if (!revision || !isEffectiveAt(revision, asOf)) {
        throw new ControlledDocumentSearchError(
          "REVISION_NOT_EFFECTIVE",
          "Only currently effective controlled document revisions can be indexed",
        );
      }
      if (revision.document.organizationId !== authorization.organizationId) {
        throw new ControlledDocumentSearchError(
          "REVISION_NOT_EFFECTIVE",
          "Controlled document revision is outside the authorized organization",
        );
      }

      const file = await readFile({
        organizationId: authorization.organizationId,
        documentId: revision.document.id,
        revisionId: revision.id,
      });
      const text = await extractor(file);
      if (text.length > MAX_INDEX_TEXT_CHARS) {
        throw new ControlledDocumentSearchError(
          "CONTENT_TOO_LARGE",
          `Searchable controlled document text cannot exceed ${MAX_INDEX_TEXT_CHARS} characters`,
        );
      }

      const context: EmbeddingInvocationContext = {
        organizationId: authorization.organizationId,
        siteId: null,
        actorId: authorization.actorId,
        purpose: "controlled-document-index",
        correlationId: revision.id,
      };
      const embedded = await input.embeddingRegistry.embed({
        providerId: input.embeddingProviderId,
        context,
        inputs: [{ id: revision.id, text }],
      });
      const embedding = embedded.embeddings[0];
      if (!embedding || embedding.id !== revision.id) {
        throw new ControlledDocumentSearchError(
          "INVALID_INDEX_METADATA",
          "Embedding provider did not return the controlled document revision vector",
        );
      }

      await input.vectorStore.upsert({
        scope: { organizationId: authorization.organizationId, siteId: null },
        namespace,
        dimensions: embedded.dimensions,
        records: [
          {
            id: revision.id,
            vector: embedding.vector,
            metadata: {
              documentId: revision.document.id,
              revisionId: revision.id,
              checksum: revision.checksum,
            },
          },
        ],
      });

      return {
        documentId: revision.document.id,
        revisionId: revision.id,
        dimensions: embedded.dimensions,
        checksum: revision.checksum,
      };
    },

    async search(args: {
      authorization: ControlledDocumentAuthorization;
      query: string;
      limit?: number;
    }): Promise<ControlledDocumentSearchResult[]> {
      const authorization = authorize(args.authorization, "document:read");
      const query = normalizeQuery(args.query);
      const limit = normalizeLimit(args.limit);
      const asOf = now();

      const embedded = await input.embeddingRegistry.embed({
        providerId: input.embeddingProviderId,
        context: {
          organizationId: authorization.organizationId,
          siteId: null,
          actorId: authorization.actorId,
          purpose: "controlled-document-semantic-search",
        },
        inputs: [{ id: "query", text: query }],
      });
      const queryEmbedding = embedded.embeddings[0];
      if (!queryEmbedding || queryEmbedding.id !== "query") {
        throw new ControlledDocumentSearchError(
          "INVALID_INDEX_METADATA",
          "Embedding provider did not return the search query vector",
        );
      }

      const hits = await input.vectorStore.query({
        scope: { organizationId: authorization.organizationId, siteId: null },
        namespace,
        dimensions: embedded.dimensions,
        vector: queryEmbedding.vector,
        limit: Math.min(MAX_RESULTS * SEARCH_OVERSAMPLE, limit * SEARCH_OVERSAMPLE),
      });
      const parsedHits = hits.map((hit) => ({ hit, source: parseIndexHit(hit) }));
      const revisionIds = [...new Set(parsedHits.map(({ source }) => source.revisionId))];
      const effective = await repository.findEffectiveRevisionsByIds({
        organizationId: authorization.organizationId,
        revisionIds,
        asOf,
      });
      const effectiveById = new Map(effective.map((revision) => [revision.id, revision]));

      const results: ControlledDocumentSearchResult[] = [];
      for (const { hit, source } of parsedHits) {
        const revision = effectiveById.get(source.revisionId);
        if (!revision || !isEffectiveAt(revision, asOf)) continue;
        if (revision.document.organizationId !== authorization.organizationId) continue;
        if (revision.document.id !== source.documentId) continue;
        if (source.checksum !== null && revision.checksum !== source.checksum) continue;

        results.push({
          score: hit.score,
          source: {
            type: "controlled-document",
            documentId: revision.document.id,
            documentCode: revision.document.code,
            documentTitle: revision.document.title,
            revisionId: revision.id,
            revision: revision.revision,
            checksum: revision.checksum,
            effectiveAt: revision.effectiveAt!.toISOString(),
            href: `/documents/${encodeURIComponent(revision.document.id)}`,
          },
        });
        if (results.length >= limit) break;
      }
      return results;
    },
  };
}
