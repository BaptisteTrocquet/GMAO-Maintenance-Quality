import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface StorageAdapter {
  put(key: string, data: Uint8Array): Promise<string>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export class InvalidStorageKeyError extends Error {
  constructor(message = "Storage key must stay inside the configured storage namespace") {
    super(message);
    this.name = "InvalidStorageKeyError";
  }
}

export class StorageConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

export class StorageProviderError extends Error {
  constructor(message = "Object storage request failed") {
    super(message);
    this.name = "StorageProviderError";
  }
}

export class StorageObjectTooLargeError extends StorageProviderError {
  constructor() {
    super("Object storage response exceeded the configured size limit");
    this.name = "StorageObjectTooLargeError";
  }
}

function validateStorageKey(key: string) {
  const segments = key.split("/");
  if (
    !key ||
    path.isAbsolute(key) ||
    key.includes("\\") ||
    key.includes("\0") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new InvalidStorageKeyError();
  }
  return segments;
}

export class LocalStorageAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(baseDir = process.env.STORAGE_LOCAL_DIR || "./data/documents") {
    this.root = path.resolve(baseDir);
  }

  private resolveKey(key: string) {
    const segments = validateStorageKey(key);
    const filePath = path.resolve(this.root, ...segments);
    if (filePath === this.root || !filePath.startsWith(`${this.root}${path.sep}`)) {
      throw new InvalidStorageKeyError();
    }
    return filePath;
  }

  async put(key: string, data: Uint8Array) {
    const filePath = this.resolveKey(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
    return key;
  }

  async get(key: string) {
    return new Uint8Array(await fs.readFile(this.resolveKey(key)));
  }

  async delete(key: string) {
    await fs.rm(this.resolveKey(key), { force: true });
  }
}

export type S3StorageAdapterConfig = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  prefix?: string;
  timeoutMs?: number;
  maxObjectBytes?: number;
};

type S3StorageAdapterOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const DEFAULT_STORAGE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OBJECT_BYTES = 25 * 1024 * 1024;

function normalizeEndpoint(value: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new StorageConfigurationError("STORAGE_S3_ENDPOINT must be a valid HTTPS URL");
  }
  if (endpoint.protocol !== "https:") {
    throw new StorageConfigurationError("STORAGE_S3_ENDPOINT must use HTTPS");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new StorageConfigurationError(
      "STORAGE_S3_ENDPOINT cannot contain credentials, query parameters or fragments",
    );
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  return endpoint;
}

function validateS3Config(config: S3StorageAdapterConfig) {
  const endpoint = normalizeEndpoint(config.endpoint);
  if (!config.bucket.trim() || config.bucket.includes("/") || config.bucket.includes("\\")) {
    throw new StorageConfigurationError("STORAGE_S3_BUCKET must be a non-empty bucket name");
  }
  if (!config.region.trim()) {
    throw new StorageConfigurationError("STORAGE_S3_REGION is required");
  }
  if (!config.accessKeyId.trim() || !config.secretAccessKey) {
    throw new StorageConfigurationError("S3 access key ID and secret access key are required");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_STORAGE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new StorageConfigurationError("S3 storage timeout must be between 100 and 60000 ms");
  }
  const maxObjectBytes = config.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  if (!Number.isInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > 250 * 1024 * 1024) {
    throw new StorageConfigurationError("S3 max object size must be between 1 byte and 250 MiB");
  }
  const prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (prefix) validateStorageKey(prefix);
  return { endpoint, timeoutMs, maxObjectBytes, prefix };
}

function sha256Hex(data: Uint8Array | string) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string) {
  return createHmac("sha256", key).update(data).digest();
}

function awsTimestamp(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maxObjectBytes: number;
  private readonly prefix: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(
    private readonly config: S3StorageAdapterConfig,
    options: S3StorageAdapterOptions = {},
  ) {
    const normalized = validateS3Config(config);
    this.endpoint = normalized.endpoint;
    this.timeoutMs = normalized.timeoutMs;
    this.maxObjectBytes = normalized.maxObjectBytes;
    this.prefix = normalized.prefix;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private objectUrl(key: string) {
    const segments = validateStorageKey(key);
    const objectSegments = [
      this.config.bucket,
      ...(this.prefix ? this.prefix.split("/") : []),
      ...segments,
    ];
    const encodedPath = objectSegments.map(encodePathSegment).join("/");
    const basePath = this.endpoint.pathname.replace(/\/+$/, "");
    const url = new URL(this.endpoint.toString());
    url.pathname = `${basePath}/${encodedPath}`.replace(/\/+/g, "/");
    return url;
  }

  private signedHeaders(method: "GET" | "PUT" | "DELETE", url: URL, payloadHash: string) {
    const now = this.now();
    const amzDate = awsTimestamp(now);
    const dateStamp = amzDate.slice(0, 8);
    const canonicalHeaders: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (this.config.sessionToken) {
      canonicalHeaders["x-amz-security-token"] = this.config.sessionToken;
    }
    const signedHeaderNames = Object.keys(canonicalHeaders).sort();
    const canonicalHeaderBlock = signedHeaderNames
      .map((name) => `${name}:${canonicalHeaders[name]!.trim()}\n`)
      .join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [
      method,
      url.pathname,
      "",
      canonicalHeaderBlock,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const dateKey = hmac(`AWS4${this.config.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, this.config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    return {
      ...canonicalHeaders,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  private async request(method: "GET" | "PUT" | "DELETE", key: string, data?: Uint8Array) {
    const url = this.objectUrl(key);
    const payloadHash = data ? sha256Hex(data) : EMPTY_SHA256;
    const headers = this.signedHeaders(method, url, payloadHash);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          ...headers,
          ...(data ? { "content-type": "application/octet-stream" } : {}),
        },
        body: data ? Buffer.from(data) : undefined,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new StorageProviderError(`Object storage request failed with HTTP ${response.status}`);
      }
      if (method !== "GET") return new Uint8Array();

      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > this.maxObjectBytes) {
        throw new StorageObjectTooLargeError();
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxObjectBytes) throw new StorageObjectTooLargeError();
      return bytes;
    } catch (error) {
      if (error instanceof StorageProviderError) throw error;
      if (controller.signal.aborted) {
        throw new StorageProviderError("Object storage request timed out");
      }
      throw new StorageProviderError();
    } finally {
      clearTimeout(timeout);
    }
  }

  async put(key: string, data: Uint8Array) {
    await this.request("PUT", key, data);
    return key;
  }

  async get(key: string) {
    return this.request("GET", key);
  }

  async delete(key: string) {
    await this.request("DELETE", key);
  }
}

function optionalPositiveInteger(value: string | undefined, name: string) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new StorageConfigurationError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function createStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: S3StorageAdapterOptions = {},
): StorageAdapter {
  const provider = (env.STORAGE_PROVIDER || "local").trim().toLowerCase();
  if (provider === "local") {
    return new LocalStorageAdapter(env.STORAGE_LOCAL_DIR || "./data/documents");
  }
  if (provider === "s3" || provider === "s3-compatible") {
    return new S3StorageAdapter(
      {
        endpoint: env.STORAGE_S3_ENDPOINT || "",
        bucket: env.STORAGE_S3_BUCKET || "",
        region: env.STORAGE_S3_REGION || "",
        accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID || "",
        secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY || "",
        sessionToken: env.STORAGE_S3_SESSION_TOKEN || undefined,
        prefix: env.STORAGE_S3_PREFIX || undefined,
        timeoutMs: optionalPositiveInteger(env.STORAGE_S3_TIMEOUT_MS, "STORAGE_S3_TIMEOUT_MS"),
        maxObjectBytes: optionalPositiveInteger(
          env.STORAGE_S3_MAX_OBJECT_BYTES,
          "STORAGE_S3_MAX_OBJECT_BYTES",
        ),
      },
      options,
    );
  }
  throw new StorageConfigurationError(`Unsupported STORAGE_PROVIDER: ${provider}`);
}

export const storage = createStorageFromEnv();
