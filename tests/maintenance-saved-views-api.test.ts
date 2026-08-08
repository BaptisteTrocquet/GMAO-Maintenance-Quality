import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  class SavedWorkOrderViewError extends Error {
    constructor(
      public readonly code: "INVALID_NAME" | "VIEW_NOT_FOUND",
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AccessDeniedError,
    SavedWorkOrderViewError,
    authenticateRequest: vi.fn(),
    assertSitePermission: vi.fn(),
    listViews: vi.fn(),
    saveView: vi.fn(),
    deleteView: vi.fn(),
  };
});

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/maintenance/saved-views", () => ({
  SavedWorkOrderViewError: mocks.SavedWorkOrderViewError,
  listSavedWorkOrderViews: mocks.listViews,
  saveWorkOrderView: mocks.saveView,
  deleteSavedWorkOrderView: mocks.deleteView,
}));

import { GET, POST } from "@/app/api/maintenance/saved-views/route";
import { DELETE } from "@/app/api/maintenance/saved-views/[viewId]/route";

const scope = { role: "TECHNICIAN" };

describe("saved work-order views API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue({
      session: { user: { id: "user-a" } },
      tenant: { scope },
    });
    mocks.listViews.mockResolvedValue([]);
    mocks.saveView.mockResolvedValue({ id: "view-1", name: "Urgent" });
    mocks.deleteView.mockResolvedValue({ id: "view-1", active: false });
  });

  it("lists only the authenticated user's views after work:read authorization", async () => {
    const response = await GET(
      new Request("https://example.test/api/maintenance/saved-views?organizationId=org-a&siteId=site-a"),
    );

    expect(response.status).toBe(200);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(scope, "site-a", "work:read");
    expect(mocks.listViews).toHaveBeenCalledWith({
      userId: "user-a",
      organizationId: "org-a",
      siteId: "site-a",
    });
  });

  it("lets a reader save a personal compound filter without requiring work:manage", async () => {
    const response = await POST(
      new Request("https://example.test/api/maintenance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          name: "Urgent unassigned",
          dueFilter: "OVERDUE",
          priorityFilter: "URGENT",
          assignmentFilter: "UNASSIGNED",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(scope, "site-a", "work:read");
    expect(mocks.saveView).toHaveBeenCalledWith({
      userId: "user-a",
      organizationId: "org-a",
      siteId: "site-a",
      name: "Urgent unassigned",
      dueFilter: "OVERDUE",
      priorityFilter: "URGENT",
      assignmentFilter: "UNASSIGNED",
    });
  });

  it("fails closed when the user lacks site work:read access", async () => {
    mocks.assertSitePermission.mockImplementation(() => {
      throw new mocks.AccessDeniedError("Denied");
    });

    const response = await GET(
      new Request("https://example.test/api/maintenance/saved-views?organizationId=org-a&siteId=site-a"),
    );

    expect(response.status).toBe(403);
    expect(mocks.listViews).not.toHaveBeenCalled();
  });

  it("deletes only through the authenticated user and requested tenant/site scope", async () => {
    const response = await DELETE(
      new Request("https://example.test/api/maintenance/saved-views/view-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a" }),
      }),
      { params: Promise.resolve({ viewId: "view-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.deleteView).toHaveBeenCalledWith({
      userId: "user-a",
      organizationId: "org-a",
      siteId: "site-a",
      viewId: "view-1",
    });
  });
});
