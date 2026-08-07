export type OpenGmaoClientOptions = {
  baseUrl: string;
  tokenId: string;
  token: string;
  fetch?: typeof fetch;
};

export type MaintenanceRequestInput = {
  title: string;
  description?: string | null;
  assetCode?: string | null;
  requesterName?: string | null;
  requesterEmail?: string | null;
  requesterRef?: string | null;
};

export type MaintenanceRequestResult = {
  idempotent: boolean;
  trackingId: string;
  workOrder: {
    id: string;
    number: string;
    status: "REQUESTED";
    requestedAt: string;
  };
};

export type MaintenanceStatusResult = {
  trackingId: string;
  workOrder: {
    number: string;
    status: string;
    requestedAt: string;
    plannedStart: string | null;
    dueAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    updatedAt: string;
  };
};

export type AssetCard = {
  code: string;
  name: string;
  status: string;
  criticality: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  updatedAt: string;
  location: { code: string; name: string } | null;
};

export type KpiCard = {
  openWorkOrders: number;
  overdueWorkOrders: number;
  inProgressWorkOrders: number;
  outOfServiceAssets: number;
  generatedAt: string;
};

export type ControlledDocument = {
  data: Uint8Array;
  mimeType: string;
  fileName: string;
  documentCode: string;
  documentTitle: string;
  revision: string;
  effectiveAt: string | null;
  asOf: string;
  checksumSha256: string;
};

type ApiEnvelope<T> = { data: T };
type ApiErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

export class OpenGmaoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpenGmaoApiError";
  }
}

function decodeHeader(value: string | null) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileNameFromDisposition(value: string | null) {
  if (!value) return "controlled-document";
  const match = value.match(/filename\*=UTF-8''([^;]+)/i);
  return match ? decodeHeader(match[1]) : "controlled-document";
}

function generatedIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `sdk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class OpenGmaoClient {
  private readonly baseUrl: string;
  private readonly tokenId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenGmaoClientOptions) {
    if (!options.baseUrl) throw new Error("baseUrl is required");
    if (!options.tokenId) throw new Error("tokenId is required");
    if (!options.token) throw new Error("token is required");

    this.baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
    this.tokenId = options.tokenId;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("A fetch implementation is required");
  }

  readonly maintenanceRequests = {
    create: async (
      input: MaintenanceRequestInput,
      options?: { idempotencyKey?: string },
    ): Promise<MaintenanceRequestResult> => {
      const url = this.url("api/v1/public/maintenance-requests");
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": options?.idempotencyKey ?? generatedIdempotencyKey(),
        },
        body: JSON.stringify(input),
      });
      return this.jsonData<MaintenanceRequestResult>(response);
    },

    status: async (trackingId: string): Promise<MaintenanceStatusResult> => {
      if (!trackingId) throw new Error("trackingId is required");
      const url = this.url("api/v1/public/request-status", { trackingId });
      const response = await this.fetchImpl(url, { headers: this.authHeaders() });
      return this.jsonData<MaintenanceStatusResult>(response);
    },
  };

  readonly assets = {
    get: async (assetCode: string): Promise<AssetCard> => {
      if (!assetCode) throw new Error("assetCode is required");
      const url = this.url("api/v1/public/assets", { assetCode });
      const response = await this.fetchImpl(url, { headers: this.authHeaders() });
      return this.jsonData<AssetCard>(response);
    },
  };

  readonly documents = {
    download: async (
      documentCode: string,
      options?: { asOf?: Date | string },
    ): Promise<ControlledDocument> => {
      if (!documentCode) throw new Error("documentCode is required");
      const asOf = options?.asOf instanceof Date ? options.asOf.toISOString() : options?.asOf;
      const url = this.url("api/v1/public/documents", {
        documentCode,
        ...(asOf ? { asOf } : {}),
      });
      const response = await this.fetchImpl(url, { headers: this.authHeaders() });
      if (!response.ok) await this.throwApiError(response);

      const buffer = await response.arrayBuffer();
      return {
        data: new Uint8Array(buffer),
        mimeType: response.headers.get("Content-Type") || "application/octet-stream",
        fileName: fileNameFromDisposition(response.headers.get("Content-Disposition")),
        documentCode: response.headers.get("X-Document-Code") || documentCode,
        documentTitle: decodeHeader(response.headers.get("X-Document-Title")),
        revision: response.headers.get("X-Document-Revision") || "",
        effectiveAt: response.headers.get("X-Document-Effective-At") || null,
        asOf: response.headers.get("X-Controlled-Copy-As-Of") || "",
        checksumSha256: response.headers.get("X-Content-SHA256") || "",
      };
    },
  };

  readonly kpis = {
    get: async (): Promise<KpiCard> => {
      const url = this.url("api/v1/public/kpis");
      const response = await this.fetchImpl(url, { headers: this.authHeaders() });
      return this.jsonData<KpiCard>(response);
    },
  };

  private url(path: string, query: Record<string, string> = {}) {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("tokenId", this.tokenId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async jsonData<T>(response: Response): Promise<T> {
    if (!response.ok) await this.throwApiError(response);
    const body = (await response.json()) as ApiEnvelope<T>;
    return body.data;
  }

  private async throwApiError(response: Response): Promise<never> {
    let body: ApiErrorEnvelope = {};
    try {
      body = (await response.json()) as ApiErrorEnvelope;
    } catch {
      // Non-JSON upstream errors are normalized below.
    }
    throw new OpenGmaoApiError(
      response.status,
      body.error?.code ?? "HTTP_ERROR",
      body.error?.message ?? `OpenGMAO API request failed with HTTP ${response.status}`,
      body.error?.details,
    );
  }
}
