import { request as httpsRequest } from "node:https";
import {
  resolvePublicWebhookTarget,
  WebhookTargetError,
} from "@/lib/webhooks/security";

const REST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "proxy-authorization",
  "x-api-key",
  "api-key",
]);
const SENSITIVE_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "authorization",
  "proxy-authorization",
]);

export type RestConnectorMethod = (typeof REST_METHODS)[number];

export type RestConnectorDefinition = {
  id: string;
  organizationId: string;
  name: string;
  baseUrl: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export type RestConnectorCredential =
  | { kind: "none"; organizationId: string }
  | { kind: "bearer"; organizationId: string; token: string }
  | { kind: "apiKey"; organizationId: string; headerName: string; value: string };

export type RestConnectorExecutionContext = {
  organizationId: string;
  siteId?: string;
  correlationId?: string;
};

export type RestConnectorRequest = {
  method: RestConnectorMethod;
  path: string;
  query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
};

export type RestConnectorResponse<T = unknown> = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  data: T;
};

export type RestConnectorTransportInput = {
  url: URL;
  address: string;
  family: 4 | 6;
  method: RestConnectorMethod;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
  maxResponseBytes: number;
};

export type RestConnectorTransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type RestConnectorTransport = (
  input: RestConnectorTransportInput,
) => Promise<RestConnectorTransportResponse>;

export class RestConnectorError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIGURATION"
      | "TENANT_SCOPE_MISMATCH"
      | "UNSAFE_HEADER"
      | "INVALID_REQUEST"
      | "UNSAFE_TARGET"
      | "NETWORK_ERROR"
      | "RESPONSE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "RestConnectorError";
  }
}

function normalizeHeaderName(name: string) {
  return name.trim().toLowerCase();
}

function assertSafeConfiguredHeaders(headers: Readonly<Record<string, string>> | undefined) {
  for (const name of Object.keys(headers ?? {})) {
    if (FORBIDDEN_REQUEST_HEADERS.has(normalizeHeaderName(name))) {
      throw new RestConnectorError(
        "UNSAFE_HEADER",
        `Sensitive header ${name} must be supplied through the runtime credential contract`,
      );
    }
  }
}

function sanitizeResponseHeaders(headers: Record<string, string | string[] | undefined>) {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = normalizeHeaderName(name);
    if (!value || SENSITIVE_RESPONSE_HEADERS.has(normalized)) continue;
    safe[normalized] = Array.isArray(value) ? value.join(", ") : value;
  }
  return safe;
}

function ensureBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RestConnectorError("INVALID_CONFIGURATION", "REST connector baseUrl must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new RestConnectorError("INVALID_CONFIGURATION", "REST connector baseUrl must use HTTPS");
  }
  if (url.username || url.password || url.hash) {
    throw new RestConnectorError(
      "INVALID_CONFIGURATION",
      "REST connector baseUrl cannot contain credentials or a fragment",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function buildRequestUrl(
  baseUrl: URL,
  path: string,
  query: RestConnectorRequest["query"],
) {
  const normalizedPath = path.trim();
  if (!normalizedPath || normalizedPath.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(normalizedPath)) {
    throw new RestConnectorError("INVALID_REQUEST", "REST connector request path must be relative");
  }

  const relativePath = normalizedPath.replace(/^\/+/, "");
  const url = new URL(relativePath, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new RestConnectorError(
      "INVALID_REQUEST",
      "REST connector request cannot escape its configured base path",
    );
  }

  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(name, String(value));
  }
  return url;
}

function credentialHeaders(credential: RestConnectorCredential) {
  if (credential.kind === "none") return {};
  if (credential.kind === "bearer") {
    if (!credential.token.trim()) {
      throw new RestConnectorError("INVALID_REQUEST", "Bearer credential is empty");
    }
    return { Authorization: `Bearer ${credential.token}` };
  }

  const headerName = credential.headerName.trim();
  const normalized = normalizeHeaderName(headerName);
  if (!headerName || normalized === "host" || normalized === "content-length" || normalized === "cookie") {
    throw new RestConnectorError("UNSAFE_HEADER", "API-key credential header name is not allowed");
  }
  if (!credential.value) {
    throw new RestConnectorError("INVALID_REQUEST", "API-key credential is empty");
  }
  return { [headerName]: credential.value };
}

function parseResponseData(body: string, headers: Record<string, string>) {
  if (!body) return null;
  const contentType = headers["content-type"] ?? "";
  if (contentType.toLowerCase().includes("json")) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  return body;
}

export const defaultRestConnectorTransport: RestConnectorTransport = async (input) =>
  new Promise<RestConnectorTransportResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: RestConnectorError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: input.address,
        family: input.family,
        port: input.url.port || 443,
        servername: input.url.hostname,
        method: input.method,
        path: `${input.url.pathname}${input.url.search}`,
        headers: {
          ...input.headers,
          Host: input.url.host,
          ...(input.body === null
            ? {}
            : { "Content-Length": Buffer.byteLength(input.body).toString() }),
        },
      },
      (response) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > input.maxResponseBytes) {
            response.destroy();
            fail(
              new RestConnectorError(
                "RESPONSE_TOO_LARGE",
                "REST connector response exceeded the configured size limit",
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", () => {
          fail(new RestConnectorError("NETWORK_ERROR", "REST connector request failed"));
        });
      },
    );

    request.setTimeout(input.timeoutMs, () => {
      request.destroy();
      fail(new RestConnectorError("NETWORK_ERROR", "REST connector request timed out"));
    });
    request.once("error", () => {
      fail(new RestConnectorError("NETWORK_ERROR", "REST connector request failed"));
    });
    if (input.body !== null) request.write(input.body);
    request.end();
  });

export function createRestConnector(
  definition: RestConnectorDefinition,
  options?: { transport?: RestConnectorTransport },
) {
  if (!definition.id.trim() || !definition.organizationId.trim() || !definition.name.trim()) {
    throw new RestConnectorError(
      "INVALID_CONFIGURATION",
      "REST connector id, organizationId and name are required",
    );
  }
  assertSafeConfiguredHeaders(definition.defaultHeaders);
  const baseUrl = ensureBaseUrl(definition.baseUrl);
  const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = definition.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new RestConnectorError(
      "INVALID_CONFIGURATION",
      "REST connector timeoutMs must be between 100 and 60000 milliseconds",
    );
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 10_000_000) {
    throw new RestConnectorError(
      "INVALID_CONFIGURATION",
      "REST connector maxResponseBytes must be between 1 and 10000000 bytes",
    );
  }
  const transport = options?.transport ?? defaultRestConnectorTransport;

  return {
    definition: {
      id: definition.id,
      organizationId: definition.organizationId,
      name: definition.name,
      baseUrl: baseUrl.toString(),
    },
    async execute<T = unknown>(input: {
      context: RestConnectorExecutionContext;
      credential: RestConnectorCredential;
      request: RestConnectorRequest;
    }): Promise<RestConnectorResponse<T>> {
      if (
        input.context.organizationId !== definition.organizationId ||
        input.credential.organizationId !== definition.organizationId
      ) {
        throw new RestConnectorError(
          "TENANT_SCOPE_MISMATCH",
          "REST connector execution context and credential must match the connector organization",
        );
      }
      if (!(REST_METHODS as readonly string[]).includes(input.request.method)) {
        throw new RestConnectorError("INVALID_REQUEST", "REST connector method is not supported");
      }
      assertSafeConfiguredHeaders(input.request.headers);
      const url = buildRequestUrl(baseUrl, input.request.path, input.request.query);

      let target: Awaited<ReturnType<typeof resolvePublicWebhookTarget>>;
      try {
        target = await resolvePublicWebhookTarget(url.toString());
      } catch (error) {
        if (error instanceof WebhookTargetError) {
          throw new RestConnectorError("UNSAFE_TARGET", "REST connector target is not publicly routable");
        }
        throw error;
      }

      const body = input.request.body === undefined ? null : JSON.stringify(input.request.body);
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(body === null ? {} : { "Content-Type": "application/json" }),
        ...(definition.defaultHeaders ?? {}),
        ...(input.request.headers ?? {}),
        ...credentialHeaders(input.credential),
      };
      if (input.context.correlationId) {
        headers["X-OpenGMAO-Correlation-Id"] = input.context.correlationId;
      }

      let response: RestConnectorTransportResponse;
      try {
        response = await transport({
          url: target.url,
          address: target.address,
          family: target.family,
          method: input.request.method,
          headers,
          body,
          timeoutMs,
          maxResponseBytes,
        });
      } catch (error) {
        if (error instanceof RestConnectorError) throw error;
        throw new RestConnectorError("NETWORK_ERROR", "REST connector request failed");
      }

      const safeHeaders = sanitizeResponseHeaders(response.headers);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        headers: safeHeaders,
        data: parseResponseData(response.body, safeHeaders) as T,
      };
    },
  };
}

export type RestConnector = ReturnType<typeof createRestConnector>;
