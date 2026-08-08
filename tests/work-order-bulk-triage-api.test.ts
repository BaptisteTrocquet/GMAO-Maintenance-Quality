import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  return {
    AccessDeniedError,
    authenticateRequest: vi.fn(),
    assertSitePermission: vi.fn(),
    bulkTriageWorkOrders: vi.fn(),
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/work-orders/bulk-triage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/work-orders/bulk-triage")>();
  return {
    ...original,
    bulkTriageWorkOrders: mocks.bulkTriageWorkOrders,
  };
});

import { POST } from "@/app/api/work-orders/bulk-triage/route";

function auth() {
  return {
    session: { user: { id: "manager-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "MAINTENANCE_MANAGER",
        allSites: false,
        siteIds: ["site-a"],
        active: true,
      },
    },
  };
}

function request(body: unknown) {
  return new Request("http://localhost/api/work-orders/bulk-triage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("bulk work-order triage API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.bulkTriageWorkOrders.mockResolvedValue({ updatedIds: ["wo-1", "wo-2"], count: 2 });
  });

  it("requires work:manage and forwards exact tenant/site selection", async () => {
    const response = await POST(
      request({
        organizationId: "org-a",
        siteId: "site-a",
        workOrderIds: ["wo-1", "wo-2"],
        changes: { priority: "HIGH", dueAt: "2026-08-20T00:00:00.000Z" },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a" }),
      "site-a",
      "work:manage",
    );
    expect(mocks.bulkTriageWorkOrders).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      workOrderIds: ["wo-1", "wo-2"],
      changes: {
        priority: "HIGH",
        dueAt: new Date("2026-08-20T00:00:00.000Z"),
      },
      actorId: "manager-1",
    });
  });

  it("returns access denied without invoking the bulk service", async () => {
    mocks.assertSitePermission.mockImplementation(() => {
      throw new mocks.AccessDeniedError("Missing permission: work:manage");
    });

    const response = await POST(
      request({
        organizationId: "org-a",
        siteId: "site-a",
        workOrderIds: ["wo-1"],
        changes: { priority: "URGENT" },
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.bulkTriageWorkOrders).not.toHaveBeenCalled();
  });

  it("rejects an empty selection at the API boundary", async () => {
    const response = await POST(
      request({
        organizationId: "org-a",
        siteId: "site-a",
        workOrderIds: [],
        changes: { priority: "HIGH" },
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.bulkTriageWorkOrders).not.toHaveBeenCalled();
  });
});
