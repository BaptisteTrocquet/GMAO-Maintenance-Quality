import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class SavedPlanningViewError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    listSavedPlanningViews: vi.fn(),
    createSavedPlanningView: vi.fn(),
    deleteSavedPlanningView: vi.fn(),
    SavedPlanningViewError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/maintenance/saved-planning-views", () => ({
  listSavedPlanningViews: mocks.listSavedPlanningViews,
  createSavedPlanningView: mocks.createSavedPlanningView,
  deleteSavedPlanningView: mocks.deleteSavedPlanningView,
  SavedPlanningViewError: mocks.SavedPlanningViewError,
}));

import { GET, POST } from "@/app/api/maintenance/saved-views/route";
import { DELETE } from "@/app/api/maintenance/saved-views/[viewId]/route";

function auth(userId = "user-session") {
  return {
    session: { user: { id: userId } },
    tenant: {
      scope: { organizationId: "org-a", role: "VIEWER", allSites: true, siteIds: [], active: true },
    },
  };
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("saved planning views API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.listSavedPlanningViews.mockResolvedValue([]);
    mocks.createSavedPlanningView.mockResolvedValue({ id: "view-1", name: "Overdue" });
    mocks.deleteSavedPlanningView.mockResolvedValue({ id: "view-1", active: false });
  });

  it("lists views using only the authenticated user identity", async () => {
    const response = await GET(
      new Request("http://localhost/api/maintenance/saved-views?organizationId=org-a&userId=spoofed"),
    );

    await expectStatus(response, 200);
    expect(mocks.listSavedPlanningViews).toHaveBeenCalledWith({
      organizationId: "org-a",
      userId: "user-session",
    });
  });

  it("creates a personal view and ignores any spoofed user field", async () => {
    const response = await POST(
      new Request("http://localhost/api/maintenance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          userId: "spoofed-user",
          name: "Overdue",
          path: "/maintenance/kanban",
          query: "due=OVERDUE",
        }),
      }),
    );

    await expectStatus(response, 201);
    expect(mocks.createSavedPlanningView).toHaveBeenCalledWith({
      organizationId: "org-a",
      userId: "user-session",
      name: "Overdue",
      path: "/maintenance/kanban",
      query: "due=OVERDUE",
    });
  });

  it("deletes only through the authenticated identity and organization", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/maintenance/saved-views/view-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", userId: "spoofed-user" }),
      }),
      { params: Promise.resolve({ viewId: "view-1" }) },
    );

    await expectStatus(response, 200);
    expect(mocks.deleteSavedPlanningView).toHaveBeenCalledWith({
      organizationId: "org-a",
      userId: "user-session",
      viewId: "view-1",
    });
  });

  it("rejects malformed JSON before authentication", async () => {
    const response = await POST(
      new Request("http://localhost/api/maintenance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken-json",
      }),
    );

    await expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });

  it("maps the per-user view limit to conflict", async () => {
    mocks.createSavedPlanningView.mockRejectedValue(
      new mocks.SavedPlanningViewError("VIEW_LIMIT_REACHED", "Too many views"),
    );

    const response = await POST(
      new Request("http://localhost/api/maintenance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          name: "Another",
          path: "/maintenance/workload",
        }),
      }),
    );

    await expectStatus(response, 409);
  });
});
