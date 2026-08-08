import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditFindFirst: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    auditLog: {
      findMany: mocks.auditFindMany,
      findFirst: mocks.auditFindFirst,
      create: mocks.auditCreate,
    },
  },
}));

import { DELETE, GET, POST } from "@/app/api/maintenance/saved-kanban-views/route";

function auth(allSites = true) {
  return {
    session: { user: { id: "user-a" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "MAINTENANCE_MANAGER" as const,
        allSites,
        siteIds: [],
        active: true,
      },
    },
  };
}

function query(viewId?: string) {
  const params = new URLSearchParams({ organizationId: "org-a", siteId: "site-a" });
  if (viewId) params.set("viewId", viewId);
  return `http://localhost/api/maintenance/saved-kanban-views?${params.toString()}`;
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("saved Kanban views API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditCreate.mockResolvedValue({ id: "audit-a" });
  });

  it("lists only after authenticating and validating the active site scope", async () => {
    const response = await GET(new Request(query()));

    await expectStatus(response, 200);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { id: true },
    });
    expect(mocks.auditFindMany).toHaveBeenCalled();
  });

  it("allows a manager to save the current supported due filter", async () => {
    const response = await POST(
      new Request(query(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          name: "Overdue morning",
          dueFilter: "OVERDUE",
        }),
      }),
    );

    await expectStatus(response, 201);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-a",
        entityType: "SavedKanbanView",
        action: "CREATED",
      }),
    });
  });

  it("rejects unsupported filters before any persistence", async () => {
    const response = await POST(
      new Request(query(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          name: "Unsafe",
          dueFilter: "ANYTHING",
        }),
      }),
    );

    await expectStatus(response, 400);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a user without access to the requested site before querying site data", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth(false));

    const response = await GET(new Request(query()));

    await expectStatus(response, 403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
  });

  it("does not delete another user's saved view", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify({
        id: "view-1",
        userId: "user-b",
        organizationId: "org-a",
        siteId: "site-a",
        name: "Other user",
        dueFilter: "OVERDUE",
        active: true,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      }),
    });

    const response = await DELETE(new Request(query("view-1"), { method: "DELETE" }));

    await expectStatus(response, 404);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
