import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import {
  ScopedVectorStore,
  type VectorMetadata,
  type VectorMetadataValue,
  type VectorStoreAdapter,
  type VectorStoreAdapterDeleteInput,
  type VectorStoreAdapterQueryInput,
  type VectorStoreAdapterUpsertInput,
  type VectorStoreQueryHit,
} from "@/lib/ai/vector-store";

const DEFAULT_MAX_CANDIDATES = 5_000;
const MIN_MAX_CANDIDATES = 1;
const MAX_MAX_CANDIDATES = 50_000;

type StoredVectorRow = {
  recordId: string;
  organizationId: string;
  siteScope: string;
  dimensions: number;
  vector: number[];
  metadataJson: Prisma.JsonValue;
};

function siteScope(siteId: string | null) {
  return siteId ?? "";
}

function siteIdFromScope(value: string) {
  return value === "" ? null : value;
}

function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Vector store request aborted");
}

function metadataFromJson(value: Prisma.JsonValue): Record<string, VectorMetadataValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored vector metadata is invalid");
  }

  const metadata: Record<string, VectorMetadataValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new Error("Stored vector metadata is not scalar");
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new Error("Stored vector metadata contains a non-finite number");
    }
    metadata[key] = item;
  }
  return metadata;
}

function metadataMatches(metadata: Record<string, VectorMetadataValue>, filter: VectorMetadata) {
  for (const [key, value] of Object.entries(filter)) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key) || metadata[key] !== value) return false;
  }
  return true;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length || left.length === 0) {
    throw new Error("Stored vector dimensions do not match the query");
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error("Stored vector contains a non-finite value");
    }
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  const score = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  if (!Number.isFinite(score)) throw new Error("Vector similarity score is invalid");
  return score;
}

function normalizeMaxCandidates(value: number | undefined) {
  const normalized = value ?? DEFAULT_MAX_CANDIDATES;
  if (
    !Number.isInteger(normalized) ||
    normalized < MIN_MAX_CANDIDATES ||
    normalized > MAX_MAX_CANDIDATES
  ) {
    throw new Error(
      `PostgreSQL vector maxCandidates must be between ${MIN_MAX_CANDIDATES} and ${MAX_MAX_CANDIDATES}`,
    );
  }
  return normalized;
}

export class PrismaVectorStoreAdapter implements VectorStoreAdapter {
  readonly id = "postgres-native";
  readonly displayName = "PostgreSQL native vector store";
  readonly enabled = true;

  private readonly maxCandidates: number;

  constructor(
    private readonly client: PrismaClient = db,
    options: { maxCandidates?: number } = {},
  ) {
    this.maxCandidates = normalizeMaxCandidates(options.maxCandidates);
  }

  async upsert(input: VectorStoreAdapterUpsertInput) {
    checkSignal(input.signal);
    const scope = siteScope(input.scope.siteId);

    await this.client.$transaction(async (tx) => {
      for (const record of input.records) {
        checkSignal(input.signal);
        await tx.aiVectorRecord.upsert({
          where: {
            organizationId_siteScope_namespace_recordId: {
              organizationId: input.scope.organizationId,
              siteScope: scope,
              namespace: input.namespace,
              recordId: record.id,
            },
          },
          create: {
            organizationId: input.scope.organizationId,
            siteScope: scope,
            namespace: input.namespace,
            recordId: record.id,
            dimensions: input.dimensions,
            vector: [...record.vector],
            metadataJson: { ...record.metadata },
          },
          update: {
            dimensions: input.dimensions,
            vector: [...record.vector],
            metadataJson: { ...record.metadata },
          },
        });
      }
    });

    checkSignal(input.signal);
    return { upserted: input.records.length };
  }

  async delete(input: VectorStoreAdapterDeleteInput) {
    checkSignal(input.signal);
    const result = await this.client.aiVectorRecord.deleteMany({
      where: {
        organizationId: input.scope.organizationId,
        siteScope: siteScope(input.scope.siteId),
        namespace: input.namespace,
        recordId: { in: [...input.ids] },
      },
    });
    checkSignal(input.signal);
    return { deleted: result.count };
  }

  async query(input: VectorStoreAdapterQueryInput): Promise<VectorStoreQueryHit[]> {
    checkSignal(input.signal);
    const rows: StoredVectorRow[] = await this.client.aiVectorRecord.findMany({
      where: {
        organizationId: input.scope.organizationId,
        siteScope: siteScope(input.scope.siteId),
        namespace: input.namespace,
        dimensions: input.dimensions,
      },
      select: {
        recordId: true,
        organizationId: true,
        siteScope: true,
        dimensions: true,
        vector: true,
        metadataJson: true,
      },
      orderBy: { recordId: "asc" },
      take: this.maxCandidates + 1,
    });
    checkSignal(input.signal);

    if (rows.length > this.maxCandidates) {
      throw new Error(
        `PostgreSQL native vector namespace exceeds the ${this.maxCandidates} candidate safety limit`,
      );
    }

    return rows
      .map((row) => {
        if (row.dimensions !== input.dimensions || row.vector.length !== input.dimensions) {
          throw new Error("Stored vector dimensions are inconsistent");
        }
        const metadata = metadataFromJson(row.metadataJson);
        if (!metadataMatches(metadata, input.filter)) return null;
        return {
          id: row.recordId,
          score: cosineSimilarity(row.vector, input.vector),
          organizationId: row.organizationId,
          siteId: siteIdFromScope(row.siteScope),
          metadata,
        } satisfies VectorStoreQueryHit;
      })
      .filter((hit): hit is VectorStoreQueryHit => hit !== null)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }
}

export function createPostgresVectorStore(
  client: PrismaClient = db,
  options: { maxCandidates?: number } = {},
) {
  return new ScopedVectorStore(new PrismaVectorStoreAdapter(client, options));
}
