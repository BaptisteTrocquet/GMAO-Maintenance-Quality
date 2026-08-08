import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  return {
    AccessDeniedError,
    authenticateRequest: vi.fn(),
    assertSitePermission: vi.fn(),
    canExecuteWorkOrder: vi.fn(),
    workOrderFindFirst: vi.fn(),
    attachmentCreate: vi.fn(),
    auditCreate: vi.fn(),
    transaction: vi.fn(),
    storagePut: vi.fn(),
    storageDelete: vi.fn(),
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/work-orders/authorization", () => ({ canExecuteWorkOrder: mocks.canExecuteWorkOrder }));
vi.mock("@/lib/storage", () => ({
  storage: { put: mocks.storagePut, delete: mocks.storageDelete },
}));
vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst },
    $transaction: mocks.transaction,
  },
}));

import { POST } from "@/app/api/work-orders/[workOrderId]/attachments/upload/route";

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

function workOrder(status = "IN_PROGRESS") {
  return {
    id: "wo-1",
    siteId: "site-a",
    status,
    assigneeId: "tech-1",
    teamId: null,
    site: { organizationId: "org-a" },
  };
}

function jpegFile(name = "camera.jpg", type = "image/jpeg") {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43])], name, { type });
}

function request(file: File) {
  const form = new FormData();
  form.append("file", file, file.name);
  return new Request(
    "http://localhost/api/work-orders/wo-1/attachments/upload?organizationId=org-a&siteId=site-a",
    { method: "POST", body: form },
  );
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

async function post(file: File) {
  const response = await POST(request(file), params);
  expect(response).toBeDefined();
  return response!;
}

describe("work order camera photo upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.assertSitePermission.mockImplementation(() => undefined);
    mocks.canExecuteWorkOrder.mockResolvedValue(true);
    mocks.workOrderFindFirst.mockResolvedValue(workOrder());
    mocks.storagePut.mockResolvedValue("stored");
    mocks.storageDelete.mockResolvedValue(undefined);
    mocks.attachmentCreate.mockResolvedValue({
      id: "photo-1",
      fileName: "camera.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 6,
      kind: "PHOTO",
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        workOrderAttachment: { create: mocks.attachmentCreate },
        auditLog: { create: mocks.auditCreate },
      }),
    );
  });

  it("stores an assigned technician photo under the scoped work-order prefix and audits it", async () => {
    const response = await post(jpegFile());

    expect(response.status).toBe(201);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(expect.anything(), "site-a", "work:update");
    expect(mocks.storagePut).toHaveBeenCalledWith(
      expect.stringMatching(/^work-orders\/org-a\/site-a\/wo-1\//),
      expect.any(Uint8Array),
    );
    expect(mocks.attachmentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workOrderId: "wo-1",
        fileName: "camera.jpg",
        mimeType: "image/jpeg",
        kind: "PHOTO",
        createdBy: "tech-1",
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PHOTO_ADDED", actorId: "tech-1" }),
    });
  });

  it("rejects a declared image whose bytes are not that image format", async () => {
    const file = new File(["not a jpeg"], "fake.jpg", { type: "image/jpeg" });
    const response = await post(file);

    expect(response.status).toBe(415);
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("rejects non-image MIME types before storage", async () => {
    const response = await post(new File(["text"], "note.txt", { type: "text/plain" }));

    expect(response.status).toBe(415);
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("blocks users who cannot execute the work order", async () => {
    mocks.canExecuteWorkOrder.mockResolvedValue(false);
    const response = await post(jpegFile());

    expect(response.status).toBe(403);
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("deletes stored bytes when the database transaction fails", async () => {
    mocks.transaction.mockRejectedValue(new Error("db failed"));

    await expect(POST(request(jpegFile()), params)).rejects.toThrow("db failed");
    expect(mocks.storageDelete).toHaveBeenCalledWith(
      expect.stringMatching(/^work-orders\/org-a\/site-a\/wo-1\//),
    );
  });
});
