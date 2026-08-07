import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  documentFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  assetDocumentFindMany: vi.fn(),
  assetDocumentUpsert: vi.fn(),
  assetDocumentFindUnique: vi.fn(),
  assetDocumentDelete: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({
  db: {
    document: { findFirst: mocks.documentFindFirst },
    asset: { findFirst: mocks.assetFindFirst },
    assetDocument: {
      findMany: mocks.assetDocumentFindMany,
      upsert: mocks.assetDocumentUpsert,
      findUnique: mocks.assetDocumentFindUnique,
      delete: mocks.assetDocumentDelete,
    },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { DELETE, GET, POST } from "@/app/api/documents/[documentId]/applicability/route";

function auth(role: "QUALITY_MANAGER" | "MAINTENANCE_MANAGER" | "VIEWER") {
  return {
    session: { user: { id: `${role.toLowerCase()}-1` } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role,
        allSites: true,
        siteIds: [],
        active: true,
      },
    },
  };
}

const context = { params: Promise.resolve({ documentId: "doc-1" }) };

function mutationRequest(method: "POST" | "DELETE", body: unknown) {
  return new Request("http://localhost/api/documents/doc-1/applicability", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("document asset applicability API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.documentFindFirst.mockResolvedValue({ id: "doc-1", code: "WI-001", title: "Inspection" });
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-1", code: "P-101", name: "Pump" });
    mocks.assetDocumentUpsert.mockResolvedValue({
      assetId: "asset-1",
      documentId: "doc-1",
      relation: "APPLICABLE",
    });
    mocks.assetDocumentFindUnique.mockResolvedValue({
      assetId: "asset-1",
      documentId: "doc-1",
      relation: "APPLICABLE",
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("allows a document manager with site read access to link an asset", async () => {
    const response = await POST(
      mutationRequest("POST", {
        organizationId: "org-a",
        siteId: "site-a",
        assetId: "asset-1",
        relation: "APPLICABLE",
      }),
      context,
    );

    await expectStatus(response, 201);
    expect(mocks.assetDocumentUpsert).toHaveBeenCalledWith({
      where: { assetId_documentId: { assetId: "asset-1", documentId: "doc-1" } },
      update: { relation: "APPLICABLE" },
      create: { assetId: "asset-1", documentId: "doc-1", relation: "APPLICABLE" },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "AssetDocument",
        entityId: "asset-1:doc-1",
        action: "LINKED",
      }),
    });
  });

  it("blocks a maintenance manager who lacks document:manage", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await POST(
      mutationRequest("POST", {
        organizationId: "org-a",
        siteId: "site-a",
        assetId: "asset-1",
      }),
      context,
    );

    await expectStatus(response, 403);
    expect(mocks.assetDocumentUpsert).not.toHaveBeenCalled();
  });

  it("rejects an asset outside the requested organization/site scope", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);

    const response = await POST(
      mutationRequest("POST", {
        organizationId: "org-a",
        siteId: "site-a",
        assetId: "asset-other",
      }),
      context,
    );

    await expectStatus(response, 404);
    expect(mocks.assetDocumentUpsert).not.toHaveBeenCalled();
  });

  it("unlinks applicability and records an audit event", async () => {
    const response = await DELETE(
      mutationRequest("DELETE", {
        organizationId: "org-a",
        siteId: "site-a",
        assetId: "asset-1",
      }),
      context,
    );

    await expectStatus(response, 200);
    expect(mocks.assetDocumentDelete).toHaveBeenCalledWith({
      where: { assetId_documentId: { assetId: "asset-1", documentId: "doc-1" } },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "UNLINKED", entityId: "asset-1:doc-1" }),
    });
  });

  it("allows a read-only document user to list applicability inside an allowed site", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    mocks.assetDocumentFindMany.mockResolvedValue([
      { assetId: "asset-1", documentId: "doc-1", relation: "APPLICABLE", asset: { code: "P-101" } },
    ]);
    const request = new Request(
      "http://localhost/api/documents/doc-1/applicability?organizationId=org-a&siteId=site-a",
    );

    const response = await GET(request, context);

    await expectStatus(response, 200);
    expect(mocks.assetDocumentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ documentId: "doc-1" }),
      }),
    );
  });
});
