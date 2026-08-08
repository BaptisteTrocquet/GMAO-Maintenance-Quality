import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  return {
    AccessDeniedError,
    authenticateRequest: vi.fn(),
    assertSitePermission: vi.fn(),
    workOrderFindFirst: vi.fn(),
    attachmentFindFirst: vi.fn(),
    storageGet: vi.fn(),
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/storage", () => ({ storage: { get: mocks.storageGet } }));
vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst },
    workOrderAttachment: { findFirst: mocks.attachmentFindFirst },
  },
}));

import { GET } from "@/app/api/work-orders/[workOrderId]/attachments/[attachmentId]/file/route";

const params = {
  params: Promise.resolve({ workOrderId: "wo-1", attachmentId: "photo-1" }),
};

function request() {
  return new Request(
    "http://localhost/api/work-orders/wo-1/attachments/photo-1/file?organizationId=org-a&siteId=site-a",
  );
}

function auth() {
  return {
    session: { user: { id: "tech-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "TECHNICIAN",
        allSites: false,
        siteIds: ["site-a"],
        active: true,
      },
    },
  };
}

describe("work order attachment file API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.assertSitePermission.mockImplementation(() => undefined);
    mocks.workOrderFindFirst.mockResolvedValue({
      id: "wo-1",
      siteId: "site-a",
      site: { organizationId: "org-a" },
    });
    mocks.attachmentFindFirst.mockResolvedValue({
      id: "photo-1",
      fileName: "camera.jpg",
      storageKey: "work-orders/org-a/site-a/wo-1/file-1",
      mimeType: "image/jpeg",
      sizeBytes: 6,
      kind: "PHOTO",
    });
    mocks.storageGet.mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]));
  });

  it("serves a scoped stored photo inline after work read permission", async () => {
    const response = await GET(request(), params);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(expect.anything(), "site-a", "work:read");
  });

  it("does not read storage for an attachment outside the selected work order", async () => {
    mocks.attachmentFindFirst.mockResolvedValue(null);
    const response = await GET(request(), params);

    expect(response.status).toBe(404);
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it("rejects legacy or forged storage keys outside the scoped work-order prefix", async () => {
    mocks.attachmentFindFirst.mockResolvedValue({
      id: "photo-1",
      fileName: "camera.jpg",
      storageKey: "documents/org-a/doc-1/rev-1/checksum",
      mimeType: "image/jpeg",
      sizeBytes: 6,
      kind: "PHOTO",
    });
    const response = await GET(request(), params);

    expect(response.status).toBe(404);
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it("keeps non-image stored bytes as a download instead of rendering them inline", async () => {
    mocks.storageGet.mockResolvedValue(new TextEncoder().encode("not an image"));
    const response = await GET(request(), params);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment");
  });
});
