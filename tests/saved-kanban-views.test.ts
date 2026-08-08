import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditFindMany: vi.fn(),
  auditFindFirst: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      findMany: mocks.auditFindMany,
      findFirst: mocks.auditFindFirst,
      create: mocks.auditCreate,
    },
  },
}));

import {
  createSavedKanbanView,
  deleteSavedKanbanView,
  listSavedKanbanViews,
} from "@/lib/maintenance/saved-kanban-views";

const scope = {
  userId: "user-a",
  organizationId: "org-a",
  siteId: "site-a",
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "view-1",
    ...scope,
    name: "Morning overdue",
    dueFilter: "OVERDUE",
    active: true,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("saved Kanban views", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("creates a normalized personal view and writes an audit snapshot", async () => {
    const view = await createSavedKanbanView({
      ...scope,
      name: "  Morning   overdue  ",
      dueFilter: "OVERDUE",
    });

    expect(view.name).toBe("Morning overdue");
    expect(view.dueFilter).toBe("OVERDUE");
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-a",
        entityType: "SavedKanbanView",
        entityId: view.id,
        action: "CREATED",
        afterJson: expect.stringContaining('"siteId":"site-a"'),
      }),
    });
  });

  it("rejects unsupported filter values before persisting", async () => {
    await expect(
      createSavedKanbanView({
        ...scope,
        name: "Unsafe",
        dueFilter: "DROP_TABLE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILTER" });

    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("returns only the latest active snapshot for each scoped view", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { entityId: "view-1", afterJson: JSON.stringify(snapshot()) },
      {
        entityId: "view-1",
        afterJson: JSON.stringify(snapshot({ dueFilter: "DUE_7_DAYS", updatedAt: "2026-08-08T01:00:00.000Z" })),
      },
      {
        entityId: "view-2",
        afterJson: JSON.stringify(snapshot({ id: "view-2", name: "Deleted", active: false })),
      },
    ]);

    const views = await listSavedKanbanViews(scope);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: "view-1", dueFilter: "DUE_7_DAYS" });
    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "SavedKanbanView",
        AND: [
          { afterJson: { contains: '"userId":"user-a"' } },
          { afterJson: { contains: '"organizationId":"org-a"' } },
          { afterJson: { contains: '"siteId":"site-a"' } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { entityId: true, afterJson: true },
    });
  });

  it("refuses to delete a view owned by another user even when its id is known", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify(snapshot({ userId: "user-b" })),
    });

    await expect(
      deleteSavedKanbanView({ viewId: "view-1", ...scope }),
    ).rejects.toMatchObject({ code: "VIEW_NOT_FOUND" });

    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
