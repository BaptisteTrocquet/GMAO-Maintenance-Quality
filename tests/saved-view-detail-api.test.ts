import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class SavedViewError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    siteFindFirst: vi.fn(),
    updateSavedView: vi.fn(),
    deleteSavedView: vi.fn(),
    SavedViewError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/saved-views", () => ({
  SavedViewError: mocks.SavedViewError,
  updateSavedView: mocks.updateSavedView,
  deleteSavedView: mocks.deleteSavedView,
}));

import { DELETE, PATCH } from "@/app/api/saved-views/[viewId]/route";

const context = { params: Promise.resolve({ viewId: "view-1" }) };

function auth() {
  return {
    session: { user: { id: "user-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "TECHNICIAN",
        allSites: true,
        siteIds: [],
        active: true,
      },
    },
  };
}

function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("saved view detail API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.updateSavedView.mockResolvedValue({
      id: "view-1",
      userId: "user-1",
      organizationId: "org-a",
      siteId: "site-a",
      surface: "WORK_ORDER_KANBAN",
      name: "Overdue review",
      filters: { due: "DUE_7_DAYS" },
      active: true,
    });
    mocks.deleteSavedView.mockResolvedValue({ id: "view-1", active: false });
  });

  it("updates only the authenticated user's view with supported filters", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/saved-views/view-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          surface: "WORK_ORDER_KANBAN",
          filters: { due: "DUE_7_DAYS" },
        }),
      }),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.updateSavedView).toHaveBeenCalledWith({
      viewId: "view-1",
      userId: "user-1",
      organizationId: "org-a",
      siteId: "site-a",
      surface: "WORK_ORDER_KANBAN",
      filters: { due: "DUE_7_DAYS" },
    });
  });

  it("rejects unsupported replay parameters at the API boundary", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/saved-views/view-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          surface: "WORK_ORDER_KANBAN",
          filters: { due: "OVERDUE", redirect: "https://example.invalid" },
        }),
      }),
      context,
    );

    expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.updateSavedView).not.toHaveBeenCalled();
  });

  it("soft-deletes a saved view in the authenticated user/site scope", async () => {
    const response = await DELETE(
      new Request(
        "http://localhost/api/saved-views/view-1?organizationId=org-a&siteId=site-a&surface=WORK_ORDER_KANBAN",
        { method: "DELETE" },
      ),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.deleteSavedView).toHaveBeenCalledWith({
      viewId: "view-1",
      userId: "user-1",
      organizationId: "org-a",
      siteId: "site-a",
      surface: "WORK_ORDER_KANBAN",
    });
  });

  it("keeps another user's view opaque", async () => {
    mocks.updateSavedView.mockRejectedValue(
      new mocks.SavedViewError("VIEW_NOT_FOUND", "Saved view not found in user scope"),
    );

    const response = await PATCH(
      new Request("http://localhost/api/saved-views/view-foreign", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          surface: "WORK_ORDER_KANBAN",
          name: "Foreign view",
        }),
      }),
      { params: Promise.resolve({ viewId: "view-foreign" }) },
    );

    expectStatus(response, 404);
  });
});