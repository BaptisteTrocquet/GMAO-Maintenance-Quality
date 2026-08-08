const STORE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const METADATA_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const MAX_ID_LENGTH = 200;
const MAX_DIMENSIONS = 65_536;
const MAX_UPSERT_RECORDS = 256;
const MAX_DELETE_IDS = 1_000;
const MAX_QUERY_RESULTS = 100;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_STRING_CHARS = 2_000;
const MAX_METADATA_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const SENSITIVE_METADATA_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "xapikey",
  "apikey",
  "password",
  "secret",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "token",
]);

export type VectorStoreScope = {
  organizationId: string;
  siteId?: string | null;
};

export type VectorMetadataValue = string | number | boolean | null;
export type VectorMetadata = Readonly<Record<string, VectorMetadataValue>>;

export type VectorStoreRecord = {
  id: string;
  vector: readonly number[];
  metadata?: VectorMetadata;
};

export type VectorStoreQueryHit = {
  id: string;
  score: number;
  organizationId: string;
  siteId: string | null;
  metadata: Record<string, VectorMetadataValue>;
};

export type VectorStoreMetadata = {
  id: string;
  displayName: string;
  enabled: boolean;
};

export type VectorStoreAdapterUpsertInput = {
  scope: Readonly<{ organizationId: string; siteId: string | null }>;
  namespace: string;
  dimensions: number;
  records: readonly Readonly<{
    id: string;
    vector: readonly number[];
    metadata: VectorMetadata;
  }>[];
  signal: AbortSignal;
};

export type VectorStoreAdapterDeleteInput = {
  scope: Readonly<{ organizationId: string; siteId: string | null }>;
  namespace: string;
  ids: readonly string[];
  signal: AbortSignal;
};

export type VectorStoreAdapterQueryInput = {
  scope: Readonly<{ organizationId: string; siteId: string | null }>;
  namespace: string;
  dimensions: number;
  vector: readonly number[];
  limit: number;
  filter: VectorMetadata;
  signal: AbortSignal;
};

export interface VectorStoreAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  upsert(input: VectorStoreAdapterUpsertInput): Promise<{ upserted: number }>;
  delete(input: VectorStoreAdapterDeleteInput): Promise<{ deleted: number }>;
  query(input: VectorStoreAdapterQueryInput): Promise<readonly VectorStoreQueryHit[]>;
}

export class VectorStoreError extends Error {
  constructor(
    public readonly code:
      | "INVALID_STORE"
      | "STORE_DISABLED"
      | "INVALID_REQUEST"
      | "ABORTED"
      | "TIMEOUT"
      | "STORE_ERROR"
      | "INVALID_RESPONSE"
      | "TENANT_SCOPE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "VectorStoreError";
  }
}

function normalizeSensitiveKey(key: string) {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

function validateAdapter(adapter: VectorStoreAdapter) {
  if (!STORE_ID_PATTERN.test(adapter.id)) {
    throw new VectorStoreError(
      "INVALID_STORE",
      "Vector store id must use lowercase letters, numbers, dots, underscores or dashes",
    );
  }
  if (!adapter.displayName.trim() || adapter.displayName.length > 100) {
    throw new VectorStoreError("INVALID_STORE", "Vector store displayName is invalid");
  }
  if (
    typeof adapter.enabled !== "boolean" ||
    typeof adapter.upsert !== "function" ||
    typeof adapter.delete !== "function" ||
    typeof adapter.query !== "function"
  ) {
    throw new VectorStoreError("INVALID_STORE", "Vector store adapter contract is invalid");
  }
}

function normalizeScope(scope: VectorStoreScope) {
  const organizationId = scope.organizationId.trim();
  const siteId = scope.siteId?.trim() || null;
  if (!organizationId || organizationId.length > MAX_ID_LENGTH || /[\u0000\r\n]/.test(organizationId)) {
    throw new VectorStoreError("INVALID_REQUEST", "Vector store organization scope is invalid");
  }
  if (siteId && (siteId.length > MAX_ID_LENGTH || /[\u0000\r\n]/.test(siteId))) {
    throw new VectorStoreError("INVALID_REQUEST", "Vector store site scope is invalid");
  }
  return Object.freeze({ organizationId, siteId });
}

function normalizeNamespace(namespace: string) {
  const value = namespace.trim();
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new VectorStoreError("INVALID_REQUEST", "Vector store namespace is invalid");
  }
  return value;
}

function normalizeDimensions(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSIONS) {
    throw new VectorStoreError(
      "INVALID_REQUEST",
      `Vector dimensions must be between 1 and ${MAX_DIMENSIONS}`,
    );
  }
  return value;
}

function normalizeId(id: string, label: string) {
  const value = id.trim();
  if (!value || value.length > MAX_ID_LENGTH || /[\u0000\r\n]/.test(value)) {
    throw new VectorStoreError("INVALID_REQUEST", `${label} is invalid`);
  }
  return value;
}

function normalizeVector(vector: readonly number[], dimensions: number) {
  if (
    !Array.isArray(vector) ||
    vector.length !== dimensions ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new VectorStoreError("INVALID_REQUEST", "Vector has invalid dimensions or values");
  }
  return Object.freeze([...vector]);
}

function normalizeMetadata(
  metadata: VectorMetadata | undefined,
  code: "INVALID_REQUEST" | "INVALID_RESPONSE" = "INVALID_REQUEST",
) {
  if (metadata === undefined) return Object.freeze({}) as VectorMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new VectorStoreError(code, "Vector metadata must be a flat object");
  }
  const entries = Object.entries(metadata);
  if (entries.length > MAX_METADATA_KEYS) {
    throw new VectorStoreError(code, `Vector metadata cannot exceed ${MAX_METADATA_KEYS} keys`);
  }

  const normalized: Record<string, VectorMetadataValue> = {};
  for (const [key, value] of entries) {
    if (!METADATA_KEY_PATTERN.test(key)) {
      throw new VectorStoreError(code, "Vector metadata contains an invalid key");
    }
    if (SENSITIVE_METADATA_KEYS.has(normalizeSensitiveKey(key))) {
      throw new VectorStoreError(code, "Vector metadata cannot contain credential-like fields");
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new VectorStoreError(code, "Vector metadata values must be scalar JSON values");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new VectorStoreError(code, "Vector metadata numbers must be finite");
    }
    if (typeof value === "string" && value.length > MAX_METADATA_STRING_CHARS) {
      throw new VectorStoreError(code, "Vector metadata string is too long");
    }
    normalized[key] = value;
  }

  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_METADATA_BYTES) {
    throw new VectorStoreError(code, `Vector metadata cannot exceed ${MAX_METADATA_BYTES} bytes`);
  }
  return Object.freeze(normalized);
}

function normalizeTimeout(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new VectorStoreError(
      "INVALID_REQUEST",
      `Vector store timeoutMs must be between 100 and ${MAX_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

async function invokeWithDeadline<T>(input: {
  operation: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted) {
    throw new VectorStoreError("ABORTED", "Vector store request was aborted");
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new VectorStoreError("TIMEOUT", "Vector store operation timed out"));
    }, input.timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (!input.signal) return;
    abortHandler = () => {
      controller.abort();
      reject(new VectorStoreError("ABORTED", "Vector store request was aborted"));
    };
    input.signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([input.operation(controller.signal), timeoutPromise, abortPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (abortHandler && input.signal) input.signal.removeEventListener("abort", abortHandler);
  }
}

function storeMetadata(adapter: VectorStoreAdapter): VectorStoreMetadata {
  return { id: adapter.id, displayName: adapter.displayName, enabled: adapter.enabled };
}

export class ScopedVectorStore {
  constructor(private readonly adapter: VectorStoreAdapter) {
    validateAdapter(adapter);
  }

  metadata(): VectorStoreMetadata {
    return storeMetadata(this.adapter);
  }

  private assertEnabled() {
    if (!this.adapter.enabled) {
      throw new VectorStoreError("STORE_DISABLED", "Vector store is disabled");
    }
  }

  private async invoke<T>(input: {
    operation: (signal: AbortSignal) => Promise<T>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) {
    this.assertEnabled();
    try {
      return await invokeWithDeadline({
        operation: input.operation,
        timeoutMs: normalizeTimeout(input.timeoutMs),
        signal: input.signal,
      });
    } catch (error) {
      if (
        error instanceof VectorStoreError &&
        (error.code === "ABORTED" || error.code === "TIMEOUT")
      ) {
        throw error;
      }
      throw new VectorStoreError("STORE_ERROR", "Vector store operation failed");
    }
  }

  async upsert(input: {
    scope: VectorStoreScope;
    namespace: string;
    dimensions: number;
    records: readonly VectorStoreRecord[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }) {
    const scope = normalizeScope(input.scope);
    const namespace = normalizeNamespace(input.namespace);
    const dimensions = normalizeDimensions(input.dimensions);
    if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > MAX_UPSERT_RECORDS) {
      throw new VectorStoreError(
        "INVALID_REQUEST",
        `Vector upsert must contain between 1 and ${MAX_UPSERT_RECORDS} records`,
      );
    }

    const seen = new Set<string>();
    const records = Object.freeze(
      input.records.map((record) => {
        const id = normalizeId(record.id, "Vector record id");
        if (seen.has(id)) {
          throw new VectorStoreError("INVALID_REQUEST", "Vector upsert contains duplicate record ids");
        }
        seen.add(id);
        return Object.freeze({
          id,
          vector: normalizeVector(record.vector, dimensions),
          metadata: normalizeMetadata(record.metadata),
        });
      }),
    );

    const result = await this.invoke({
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      operation: (signal) => this.adapter.upsert({ scope, namespace, dimensions, records, signal }),
    });
    if (
      !result ||
      !Number.isInteger(result.upserted) ||
      result.upserted < 0 ||
      result.upserted > records.length
    ) {
      throw new VectorStoreError("INVALID_RESPONSE", "Vector store returned an invalid upsert count");
    }
    return { upserted: result.upserted };
  }

  async delete(input: {
    scope: VectorStoreScope;
    namespace: string;
    ids: readonly string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }) {
    const scope = normalizeScope(input.scope);
    const namespace = normalizeNamespace(input.namespace);
    if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > MAX_DELETE_IDS) {
      throw new VectorStoreError(
        "INVALID_REQUEST",
        `Vector delete must contain between 1 and ${MAX_DELETE_IDS} ids`,
      );
    }
    const ids = input.ids.map((id) => normalizeId(id, "Vector record id"));
    if (new Set(ids).size !== ids.length) {
      throw new VectorStoreError("INVALID_REQUEST", "Vector delete contains duplicate record ids");
    }

    const result = await this.invoke({
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      operation: (signal) => this.adapter.delete({ scope, namespace, ids: Object.freeze(ids), signal }),
    });
    if (
      !result ||
      !Number.isInteger(result.deleted) ||
      result.deleted < 0 ||
      result.deleted > ids.length
    ) {
      throw new VectorStoreError("INVALID_RESPONSE", "Vector store returned an invalid delete count");
    }
    return { deleted: result.deleted };
  }

  async query(input: {
    scope: VectorStoreScope;
    namespace: string;
    dimensions: number;
    vector: readonly number[];
    limit?: number;
    filter?: VectorMetadata;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<VectorStoreQueryHit[]> {
    const scope = normalizeScope(input.scope);
    const namespace = normalizeNamespace(input.namespace);
    const dimensions = normalizeDimensions(input.dimensions);
    const vector = normalizeVector(input.vector, dimensions);
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_RESULTS) {
      throw new VectorStoreError(
        "INVALID_REQUEST",
        `Vector query limit must be between 1 and ${MAX_QUERY_RESULTS}`,
      );
    }
    const filter = normalizeMetadata(input.filter);

    const result = await this.invoke({
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      operation: (signal) =>
        this.adapter.query({ scope, namespace, dimensions, vector, limit, filter, signal }),
    });
    if (!Array.isArray(result) || result.length > limit) {
      throw new VectorStoreError("INVALID_RESPONSE", "Vector store returned an invalid result set");
    }

    const seen = new Set<string>();
    return result.map((hit) => {
      if (!hit || typeof hit !== "object") {
        throw new VectorStoreError("INVALID_RESPONSE", "Vector store returned an invalid result");
      }
      const id = normalizeId(hit.id, "Vector result id");
      if (seen.has(id)) {
        throw new VectorStoreError("INVALID_RESPONSE", "Vector store returned duplicate result ids");
      }
      seen.add(id);
      if (!Number.isFinite(hit.score)) {
        throw new VectorStoreError("INVALID_RESPONSE", "Vector store returned an invalid score");
      }
      const hitOrganizationId = typeof hit.organizationId === "string" ? hit.organizationId : "";
      const hitSiteId = hit.siteId === null || typeof hit.siteId === "string" ? hit.siteId : undefined;
      if (hitOrganizationId !== scope.organizationId || hitSiteId !== scope.siteId) {
        throw new VectorStoreError(
          "TENANT_SCOPE_MISMATCH",
          "Vector store returned a result outside the requested tenant scope",
        );
      }
      const metadata = normalizeMetadata(hit.metadata, "INVALID_RESPONSE");
      return { id, score: hit.score, organizationId: scope.organizationId, siteId: scope.siteId, metadata: { ...metadata } };
    });
  }
}

export function createDisabledVectorStoreAdapter(input?: {
  id?: string;
  displayName?: string;
}): VectorStoreAdapter {
  return {
    id: input?.id ?? "disabled",
    displayName: input?.displayName ?? "Vector store disabled",
    enabled: false,
    async upsert() {
      throw new Error("Disabled vector store must never be invoked");
    },
    async delete() {
      throw new Error("Disabled vector store must never be invoked");
    },
    async query() {
      throw new Error("Disabled vector store must never be invoked");
    },
  };
}
