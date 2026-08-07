import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  workOrderFindFirst: vi.fn(),
  attachmentFindMany: vi.fn(),
  attachmentCreate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst },
    workOrderAttachment: {
      findMany: mocks.attachmentFindMany,
      create: mocks.attachmentCreate,
    },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { POST } from "@/app/api/work-orders/[workOrderId]/attachments/route";

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
    tenant: {
      scope: { organizationId: "org-a", role, allSites: true, siteIds: [], active: true },
    },
  };
}

function workOrder(input?: { assigneeId?: string | null; status?: string }) {
  return {
    id: "wo-1",
    siteId: "site-a",
    status: input?.status ?? "IN_PROGRESS",
    assigneeId: input?.assigneeId ?? "tech-1",
  };
}

function request() {
  return new Request("http://localhost/api/work-orders/wo-1/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      fileName: "inspection-photo.jpg",
      storageKey: "work-orders/wo-1/inspection-photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 128000,
      kind: "PHOTO",
    }),
  });
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("work order attachments API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    mocks.workOrderFindFirst.mockResolvedValue(workOrder());
    mocks.attachmentCreate.mockResolvedValue({
      id: "attachment-1",
      workOrderId: "wo-1",
      fileName: "inspection-photo.jpg",
      storageKey: "work-orders/wo-1/inspection-photo.jpg",
      kind: "PHOTO",
      createdBy: "tech-1",
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("adds a photo reference for the assigned technician and audits it", async () => {
    const response = await POST(request(), params);

    await expectStatus(response, 201);
    expect(mocks.attachmentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workOrderId: "wo-1",
        fileName: "inspection-photo.jpg",
        kind: "PHOTO",
        createdBy: "tech-1",
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "ATTACHMENT_ADDED", actorId: "tech-1" }),
    });
  });

  it("blocks an unassigned technician from adding attachments", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder({ assigneeId: "tech-2" }));

    const response = await POST(request(), params);

    await expectStatus(response, 403);
    expect(mocks.attachmentCreate).not.toHaveBeenCalled();
  });

  it("rejects attachments on cancelled work orders", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder({ status: "CANCELLED" }));

    const response = await POST(request(), params);

    await expectStatus(response, 409);
    expect(mocks.attachmentCreate).not.toHaveBeenCalled();
  });

  it("returns not found when the work order is outside the requested tenant/site", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(null);

    const response = await POST(request(), params);

    await expectStatus(response, 404);
    expect(mocks.attachmentCreate).not.toHaveBeenCalled();
  });
});
