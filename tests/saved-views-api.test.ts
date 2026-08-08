import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class SavedViewError extends Error {
    constructor(
      public readonly code: "VIEW_NOT_FOUND" | "VIEW_NAME_CONFLICT" | "INVALID_VIEW_NAME",
      message: string,
    ) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    siteFindFirst: vi.fn(),
    listSavedViews: vi.fn(),
    createSavedView: vi.fn(),
    SavedViewError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/saved-views", () => ({
  SAVED_VIEW_SURFACES: ["WORK_ORDER_KANBAN"],
  SavedViewError: mocks.SavedViewError,
  listSavedViews: mocks.listSavedViews,
  createSavedView: mocks.createSavedView,
}));

import { GET, POST } from "@/app/api/saved-views/route";

function auth(allSites = true) {
  return {
    session: { user: { id: "user-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "TECHNICIAN",
        allSites,
        siteIds: allSites ? [] : ["site-other"],
        active: true,
      },
    },
  };
}

function getRequest() {
  return new Request(
    "http://localhost/api/saved-views?organizationId=org-a&siteId=site-a&surface=WORK_ORDER_KANBAN",
  );
}

function postRequest() {
  return new Request("http://localhost/api/saved-views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      surface: "WORK_ORDER_KANBAN",
      name: "Overdue review",
      filters: { due: "OVERDUE" },
    }),
  });
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("saved views API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.listSavedViews.mockResolvedValue([]);
    mocks.createSavedView.mockResolvedValue({
      id: "view-1",
      userId: "user-1",
      organizationId: "org-a",
      siteId: "site-a",
      surface: "WORK_ORDER_KANBAN",
      name: "Overdue review",
      filters: { due: "OVERDUE" },
      active: true,
    });
  });

  it("lists only views for the authenticated user and requested site", async () => {
    const response = await GET(getRequest());

    await expectStatus(response, 200);
    expect(mocks.listSavedViews).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-a",
      siteId: "site-a",
      surface: "WORK_ORDER_KANBAN",
    });
  });

  it("lets a site reader save their own current filter", async () => {
    const response = await POST(postRequest());

    await expectStatus(response, 201);
    expect(mocks.createSavedView).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-a",
      siteId: "site-a",
      surface: "WORK_ORDER_KANBAN",
      name: "Overdue review",
      filters: { due: "OVERDUE" },
    });
  });

  it("rejects a user without access to the requested site before reading views", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth(false));

    const response = await GET(getRequest());

    await expectStatus(response, 403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.listSavedViews).not.toHaveBeenCalled();
  });
});
