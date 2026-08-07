import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  siteFindFirst: vi.fn(),
  createRequest: vi.fn(),
  getStatus: vi.fn(),
  getAsset: vi.fn(),
  issueDocument: vi.fn(),
  getKpis: vi.fn(),
}));

vi.mock("@/lib/integrations/api-keys", () => ({
  authenticateApiKeyRequest: mocks.authenticate,
}));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/public-requests/create-request", () => ({
  createPublicMaintenanceRequest: mocks.createRequest,
  PublicMaintenanceRequestError: class PublicMaintenanceRequestError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
}));
vi.mock("@/lib/public-requests/status", () => ({
  getPublicMaintenanceRequestStatus: mocks.getStatus,
  PublicRequestStatusError: class PublicRequestStatusError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
}));
vi.mock("@/lib/public-assets/card", () => ({
  getPublicAssetCard: mocks.getAsset,
  PublicAssetCardError: class PublicAssetCardError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
}));
vi.mock("@/lib/public-documents/viewer", () => ({
  issuePublicControlledDocument: mocks.issueDocument,
  PublicDocumentViewerError: class PublicDocumentViewerError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
}));
vi.mock("@/lib/public-kpis/card", () => ({
  getPublicKpiCard: mocks.getKpis,
  PublicKpiCardError: class PublicKpiCardError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
}));

import { POST as createMaintenance } from "@/app/api/v1/server/maintenance-requests/route";
import { GET as getStatus } from "@/app/api/v1/server/request-status/route";
import { GET as getAsset } from "@/app/api/v1/server/assets/route";
import { GET as getDocument } from "@/app/api/v1/server/documents/route";
import { GET as getKpis } from "@/app/api/v1/server/kpis/route";

const token = {
  id: "key-record-1",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Server integration",
  tokenHash: "hash",
  mode: "EMBEDDED" as const,
  allowedOrigins: [],
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  revokedAt: null,
  createdById: "manager-1",
  createdAt: new Date("2026-08-07T20:00:00.000Z"),
  lastUsedAt: null,
  scopes: [
    "maintenance:request:create",
    "maintenance:request:status",
    "asset:read",
    "document:read",
    "kpi:read",
  ],
};

function request(path: string) {
  return new Request(`http://localhost${path}`, { headers: { "X-API-Key": "gmao_sk_secret" } });
}

describe("server API-key routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ token });
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.createRequest.mockResolvedValue({
      idempotent: false,
      trackingId: "tracking-1",
      workOrder: { id: "wo-1", number: "WO-P-DEMO", status: "REQUESTED", requestedAt: new Date() },
    });
    mocks.getStatus.mockResolvedValue({ trackingId: "tracking-1", workOrder: { status: "IN_PROGRESS" } });
    mocks.getAsset.mockResolvedValue({ code: "ASSET-100", name: "Example asset" });
    mocks.issueDocument.mockResolvedValue({
      document: { code: "SOP-100", title: "Safe operating procedure" },
      revision: { revision: "3", effectiveAt: new Date("2026-08-01T00:00:00.000Z") },
      file: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "application/pdf",
        fileName: "SOP-100-r3.pdf",
        checksum: "a".repeat(64),
      },
      asOf: new Date("2026-08-07T12:00:00.000Z"),
    });
    mocks.getKpis.mockResolvedValue({ openWorkOrders: 4, overdueWorkOrders: 1, inProgressWorkOrders: 2, outOfServiceAssets: 0, generatedAt: new Date() });
  });

  it("uses maintenance:request:create for server request creation", async () => {
    const response = await createMaintenance(
      new Request("http://localhost/api/v1/server/maintenance-requests", {
        method: "POST",
        headers: {
          "X-API-Key": "gmao_sk_secret",
          "Idempotency-Key": "server-request-0001",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Unexpected vibration" }),
      }),
    );

    expect(response?.status).toBe(201);
    expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Request), "maintenance:request:create");
    expect(mocks.createRequest).toHaveBeenCalledWith(expect.objectContaining({ token, origin: null }));
  });

  it("uses maintenance:request:status for tracking", async () => {
    const response = await getStatus(request("/api/v1/server/request-status?trackingId=tracking-1"));
    expect(response?.status).toBe(200);
    expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Request), "maintenance:request:status");
    expect(mocks.getStatus).toHaveBeenCalledWith({ token, trackingId: "tracking-1", origin: null });
  });

  it("uses asset:read for asset cards", async () => {
    const response = await getAsset(request("/api/v1/server/assets?assetCode=ASSET-100"));
    expect(response?.status).toBe(200);
    expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Request), "asset:read");
    expect(mocks.getAsset).toHaveBeenCalledWith({ token, assetCode: "ASSET-100", origin: null });
  });

  it("uses document:read for effective controlled documents", async () => {
    const response = await getDocument(request("/api/v1/server/documents?documentCode=SOP-100&asOf=2026-08-07T12:00:00.000Z"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("X-Controlled-Copy")).toBe("true");
    expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Request), "document:read");
    expect(mocks.issueDocument).toHaveBeenCalledWith({
      token,
      documentCode: "SOP-100",
      asOf: new Date("2026-08-07T12:00:00.000Z"),
      origin: null,
    });
  });

  it("uses kpi:read for aggregate site KPIs", async () => {
    const response = await getKpis(request("/api/v1/server/kpis"));
    expect(response?.status).toBe(200);
    expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Request), "kpi:read");
    expect(mocks.getKpis).toHaveBeenCalledWith({ token, origin: null });
  });
});
