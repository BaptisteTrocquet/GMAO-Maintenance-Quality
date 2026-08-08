import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  bulkTriage: vi.fn(),
  listOptions: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/work-orders/bulk-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/work-orders/bulk-actions")>();
  return {
    ...actual,
    bulkTriageWorkOrders: mocks.bulkTriage,
    listBulkActionOptions: mocks.listOptions,
  };
});

import { GET, POST } from "@/app/api/work-orders/bulk-actions/route";

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
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

function postRequest(body: unknown) {
  return new Request("http://localhost/api/work-orders/bulk-actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest() {
  return new Request("http://localhost/api/work-orders/bulk-actions?organizationId=org-a&siteId=site-a");
}

const payload = {
  organizationId: "org-a",
  siteId: "site-a",
  workOrderIds: ["wo-1", "wo-2"],
  operation: { type: "SET_PRIORITY", priority: "HIGH" },
};

describe("work-order bulk actions API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.bulkTriage.mockResolvedValue({ count: 2, workOrders: [] });
    mocks.listOptions.mockResolvedValue({ workOrders: [], teams: [], assignees: [], truncated: false });
  });

  it("requires work:manage for both candidate listing and writes", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const getResponse = await GET(getRequest());
    const postResponse = await POST(postRequest(payload));

    expect(getResponse.status).toBe(403);
    expect(postResponse.status).toBe(403);
    expect(mocks.listOptions).not.toHaveBeenCalled();
    expect(mocks.bulkTriage).not.toHaveBeenCalled();
  });

  it("validates active site ownership before listing candidates", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(getRequest());

    expect(response.status).toBe(404);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { id: true },
    });
    expect(mocks.listOptions).not.toHaveBeenCalled();
  });

  it("passes the authenticated actor and exact selected IDs to the atomic service", async () => {
    const response = await POST(postRequest(payload));

    expect(response.status).toBe(200);
    expect(mocks.bulkTriage).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderIds: ["wo-1", "wo-2"],
      operation: { type: "SET_PRIORITY", priority: "HIGH" },
      actorId: "manager-1",
    });
  });

  it("rejects malformed bulk payloads before authentication", async () => {
    const response = await POST(postRequest({ ...payload, workOrderIds: [] }));

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.bulkTriage).not.toHaveBeenCalled();
  });
});