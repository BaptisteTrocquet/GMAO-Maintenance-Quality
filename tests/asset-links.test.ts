import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  partFindFirst: vi.fn(),
  documentFindFirst: vi.fn(),
  assetPartUpsert: vi.fn(),
  assetDocumentUpsert: vi.fn(),
  attachmentCreate: vi.fn(),
  auditCreate: vi.fn(),
  authenticateRequest: vi.fn(),
  assertSitePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    asset: { findFirst: mocks.assetFindFirst },
    part: { findFirst: mocks.partFindFirst },
    document: { findFirst: mocks.documentFindFirst },
    assetPart: { upsert: mocks.assetPartUpsert },
    assetDocument: { upsert: mocks.assetDocumentUpsert },
    assetAttachment: { create: mocks.attachmentCreate },
    auditLog: { create: mocks.auditCreate },
  },
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", async () => {
  const actual = await vi.importActual<typeof import("@/lib/access-control")>("@/lib/access-control");
  return { ...actual, assertSitePermission: mocks.assertSitePermission };
});

import { POST } from "@/app/api/assets/[assetId]/links/route";

const auth = {
  session: { user: { id: "user-1" } },
  tenant: { scope: { organizationId: "org-a", role: "ADMIN", allSites: true, siteIds: [], active: true } },
};

function request(body: unknown) {
  return new Request("http://localhost/api/assets/asset-1/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("asset links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-1" });
  });

  it("rejects a spare part from another organization", async () => {
    mocks.partFindFirst.mockResolvedValue(null);

    const response = await POST(
      request({ type: "part", organizationId: "org-a", siteId: "site-a", partId: "part-b", quantityRecommended: 2 }),
      { params: Promise.resolve({ assetId: "asset-1" }) },
    );

    expect(response).toBeDefined();
    expect(response!.status).toBe(404);
    expect(mocks.partFindFirst).toHaveBeenCalledWith({
      where: { id: "part-b", organizationId: "org-a" },
      select: { id: true },
    });
    expect(mocks.assetPartUpsert).not.toHaveBeenCalled();
  });

  it("rejects a controlled document from another organization", async () => {
    mocks.documentFindFirst.mockResolvedValue(null);

    const response = await POST(
      request({ type: "document", organizationId: "org-a", siteId: "site-a", documentId: "doc-b" }),
      { params: Promise.resolve({ assetId: "asset-1" }) },
    );

    expect(response).toBeDefined();
    expect(response!.status).toBe(404);
    expect(mocks.assetDocumentUpsert).not.toHaveBeenCalled();
  });

  it("creates a photo attachment and audit event", async () => {
    mocks.attachmentCreate.mockResolvedValue({ id: "attachment-1", assetId: "asset-1", kind: "PHOTO" });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });

    const response = await POST(
      request({
        type: "attachment",
        organizationId: "org-a",
        siteId: "site-a",
        fileName: "equipment-photo.jpg",
        storageKey: "assets/asset-1/equipment-photo.jpg",
        mimeType: "image/jpeg",
        kind: "PHOTO",
      }),
      { params: Promise.resolve({ assetId: "asset-1" }) },
    );

    expect(response).toBeDefined();
    expect(response!.status).toBe(201);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityType: "AssetAttachment", entityId: "attachment-1", action: "CREATED" }),
    });
  });
});
