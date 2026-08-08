import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class SavedMaintenanceViewError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    siteFindFirst: vi.fn(),
    listViews: vi.fn(),
    createView: vi.fn(),
    deleteView: vi.fn(),
    SavedMaintenanceViewError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));
vi.mock("@/lib/db", () => ({
  db: { site: { findFirst: mocks.siteFindFirst } },
}));
vi.mock("@/lib/maintenance/saved-views", () => ({
  listSavedMaintenanceViews: mocks.listViews,
  createSavedMaintenanceView: mocks.createView,
  deleteSavedMaintenanceView: mocks.deleteView,
  SavedMaintenanceViewError: mocks.SavedMaintenanceViewError,
}));

import { DELETE, GET, POST } from "@/app/api/maintenance/saved-views/route";

function authenticated(userId = "user-1") {
  return {
    session: { user: { id: userId } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "MAINTENANCE_MANAGER" as const,
        allSites: true,
        siteIds: [],
        active: true,
      },
    },
  };
}

function requireResponse(response: Response | undefined) {
  expect(response).toBeDefined();
  return response as Response;
}

describe("maintenance saved views API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(authenticated());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.listViews.mockResolvedValue([]);
    mocks.createView.mockImplementation(async (input) => ({ id: "view-1", ...input, active: true }));
    mocks.deleteView.mockImplementation(async (input) => ({ id: input.viewId, active: false }));
  });

  it("lists only with the authenticated user identity", async () => {
    const response = requireResponse(
      await GET(
        new Request(
          "http://localhost/api/maintenance/saved-views?organizationId=org-a&siteId=site-a&surface=KANBAN",
        ),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.listViews).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-1",
      surface: "KANBAN",
    });
  });

  it("creates a view for the authenticated user and ignores any client identity concept", async () => {
    const response = requireResponse(
      await POST(
        new Request("http://localhost/api/maintenance/saved-views", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-a",
            siteId: "site-a",
            surface: "KANBAN",
            name: "My overdue work",
            config: { dueFilter: "OVERDUE" },
          }),
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(mocks.createView).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-1",
      surface: "KANBAN",
      name: "My overdue work",
      config: { dueFilter: "OVERDUE" },
    });
  });

  it("fails closed when the requested site is outside the organization scope", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = requireResponse(
      await GET(
        new Request(
          "http://localhost/api/maintenance/saved-views?organizationId=org-a&siteId=site-b&surface=KANBAN",
        ),
      ),
    );

    expect(response.status).toBe(404);
    expect(mocks.listViews).not.toHaveBeenCalled();
  });

  it("deletes through the authenticated user scope", async () => {
    const response = requireResponse(
      await DELETE(
        new Request(
          "http://localhost/api/maintenance/saved-views?organizationId=org-a&siteId=site-a&viewId=2bf1b68f-78de-49c4-a4d3-77f64711cc0e",
          { method: "DELETE" },
        ),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.deleteView).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-1",
      viewId: "2bf1b68f-78de-49c4-a4d3-77f64711cc0e",
    });
  });

  it("rejects unsupported filter payloads before touching persistence", async () => {
    const response = requireResponse(
      await POST(
        new Request("http://localhost/api/maintenance/saved-views", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-a",
            siteId: "site-a",
            surface: "KANBAN",
            name: "Bad filter",
            config: { dueFilter: "EVERYTHING" },
          }),
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.createView).not.toHaveBeenCalled();
  });
});
