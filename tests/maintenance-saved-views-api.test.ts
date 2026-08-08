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

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/maintenance/saved-views", () => ({
  listSavedMaintenanceViews: mocks.listViews,
  createSavedMaintenanceView: mocks.createView,
  deleteSavedMaintenanceView: mocks.deleteView,
  SavedMaintenanceViewError: mocks.SavedMaintenanceViewError,
}));

import { DELETE, GET, POST } from "@/app/api/maintenance/saved-views/route";

function auth(input: { allSites?: boolean; siteIds?: string[] } = {}) {
  return {
    session: { user: { id: "user-a" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "TECHNICIAN",
        allSites: input.allSites ?? true,
        siteIds: input.siteIds ?? [],
        active: true,
      },
    },
  };
}

function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
  return response;
}

describe("maintenance saved views API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.listViews.mockResolvedValue([]);
    mocks.createView.mockResolvedValue({ id: "view-1", name: "Overdue review" });
    mocks.deleteView.mockResolvedValue({ id: "view-1", active: false });
  });

  it("lists only the authenticated user's views for the requested site and surface", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/maintenance/saved-views?organizationId=org-a&siteId=site-a&surface=KANBAN",
      ),
    );

    expectStatus(response, 200);
    expect(mocks.listViews).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      surface: "KANBAN",
    });
  });

  it("creates a personal calendar view using the authenticated user id", async () => {
    const response = await POST(
      new Request("http://localhost/api/maintenance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          surface: "CALENDAR",
          name: "August planning",
          config: { month: "2026-08" },
        }),
      }),
    );

    expectStatus(response, 201);
    expect(mocks.createView).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      surface: "CALENDAR",
      name: "August planning",
      config: { month: "2026-08" },
    });
  });

  it("rejects a site outside the authenticated membership scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ allSites: false, siteIds: ["site-b"] }));

    const response = await GET(
      new Request(
        "http://localhost/api/maintenance/saved-views?organizationId=org-a&siteId=site-a&surface=KANBAN",
      ),
    );

    expectStatus(response, 403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.listViews).not.toHaveBeenCalled();
  });

  it("rejects invalid calendar months before persistence", async () => {
    const response = await POST(
      new Request("http://localhost/api/maintenance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          surface: "CALENDAR",
          name: "Bad month",
          config: { month: "2026-99" },
        }),
      }),
    );

    expectStatus(response, 400);
    expect(mocks.createView).not.toHaveBeenCalled();
  });

  it("deletes only in the authenticated user and site scope", async () => {
    const response = await DELETE(
      new Request(
        "http://localhost/api/maintenance/saved-views?organizationId=org-a&siteId=site-a&viewId=11111111-1111-4111-8111-111111111111",
        { method: "DELETE" },
      ),
    );

    expectStatus(response, 200);
    expect(mocks.deleteView).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      viewId: "11111111-1111-4111-8111-111111111111",
    });
  });
});
