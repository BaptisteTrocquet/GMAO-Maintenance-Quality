import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      create: mocks.create,
    },
  },
}));

import {
  createSavedView,
  deleteSavedView,
  listSavedViews,
  updateSavedView,
} from "@/lib/saved-views";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "view-1",
    userId: "user-1",
    organizationId: "org-a",
    siteId: "site-a",
    surface: "WORK_ORDER_KANBAN",
    name: "Overdue review",
    filters: { due: "OVERDUE" },
    active: true,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

const scope = {
  userId: "user-1",
  organizationId: "org-a",
  siteId: "site-a",
  surface: "WORK_ORDER_KANBAN" as const,
};

describe("saved views", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
    mocks.findFirst.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: "audit-1" });
  });

  it("returns only the latest active snapshot for each view", async () => {
    mocks.findMany.mockResolvedValue([
      { entityId: "view-1", afterJson: JSON.stringify(snapshot()) },
      {
        entityId: "view-1",
        afterJson: JSON.stringify(snapshot({ name: "Morning overdue", updatedAt: "2026-08-08T01:00:00.000Z" })),
      },
      {
        entityId: "view-2",
        afterJson: JSON.stringify(snapshot({ id: "view-2", name: "Deleted", active: false })),
      },
    ]);

    const views = await listSavedViews(scope);

    expect(views).toHaveLength(1);
    expect(views[0]?.name).toBe("Morning overdue");
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityType: "SavedView", AND: expect.any(Array) }),
      }),
    );
  });

  it("rejects a duplicate name case-insensitively inside the same user scope", async () => {
    mocks.findMany.mockResolvedValue([
      { entityId: "view-1", afterJson: JSON.stringify(snapshot()) },
    ]);

    await expect(
      createSavedView({ ...scope, name: "  overdue REVIEW ", filters: { due: "ALL" } }),
    ).rejects.toMatchObject({ code: "VIEW_NAME_CONFLICT" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates an immutable audit snapshot owned by the current user", async () => {
    const view = await createSavedView({
      ...scope,
      name: "Due soon",
      filters: { due: "DUE_7_DAYS" },
    });

    expect(view.name).toBe("Due soon");
    expect(view.userId).toBe("user-1");
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-1",
        entityType: "SavedView",
        entityId: view.id,
        action: "CREATED",
      }),
    });
  });

  it("does not allow another user to update a saved view", async () => {
    mocks.findFirst.mockResolvedValue({
      afterJson: JSON.stringify(snapshot({ userId: "user-other" })),
    });

    await expect(
      updateSavedView({ ...scope, viewId: "view-1", filters: { due: "ALL" } }),
    ).rejects.toMatchObject({ code: "VIEW_NOT_FOUND" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("soft-deletes by appending an inactive snapshot", async () => {
    mocks.findFirst.mockResolvedValue({ afterJson: JSON.stringify(snapshot()) });

    const deleted = await deleteSavedView({ ...scope, viewId: "view-1" });

    expect(deleted.active).toBe(false);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-1",
        entityType: "SavedView",
        entityId: "view-1",
        action: "DELETED",
        beforeJson: expect.any(String),
        afterJson: expect.stringContaining('"active":false'),
      }),
    });
  });
});
