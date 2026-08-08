import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      findFirst: mocks.auditFindFirst,
      findMany: mocks.auditFindMany,
      create: mocks.auditCreate,
    },
  },
}));

import { buildWorkOrderBoardWhere } from "@/lib/maintenance/board";
import {
  deleteSavedWorkOrderView,
  listSavedWorkOrderViews,
  saveWorkOrderView,
} from "@/lib/maintenance/saved-views";

const now = new Date("2026-08-08T12:00:00.000Z");

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "view-1",
    userId: "user-a",
    organizationId: "org-a",
    siteId: "site-a",
    name: "Urgent backlog",
    dueFilter: "OVERDUE",
    priorityFilter: "URGENT",
    assignmentFilter: "ALL",
    active: true,
    updatedAt: "2026-08-08T10:00:00.000Z",
    ...overrides,
  };
}

describe("maintenance saved views", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("pushes priority and unassigned filters into the bounded database query", () => {
    expect(
      buildWorkOrderBoardWhere({
        organizationId: "org-a",
        siteId: "site-a",
        dueFilter: "OVERDUE",
        priorityFilter: "URGENT",
        assignmentFilter: "UNASSIGNED",
        now,
      }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
      dueAt: { lt: now },
      priority: "URGENT",
      assigneeId: null,
      teamId: null,
    });
  });

  it("scopes My work to direct assignment or maintenance-team membership", () => {
    expect(
      buildWorkOrderBoardWhere({
        organizationId: "org-a",
        siteId: "site-a",
        dueFilter: "ALL",
        assignmentFilter: "MY_WORK",
        userId: "user-a",
        now,
      }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: {
        in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED", "COMPLETED"],
      },
      OR: [
        { assigneeId: "user-a" },
        { team: { members: { some: { userId: "user-a" } } } },
      ],
    });
  });

  it("normalizes a name and stores the current compound filters as an immutable snapshot", async () => {
    const saved = await saveWorkOrderView({
      userId: "user-a",
      organizationId: "org-a",
      siteId: "site-a",
      name: "  Urgent   backlog  ",
      dueFilter: "OVERDUE",
      priorityFilter: "URGENT",
      assignmentFilter: "UNASSIGNED",
    });

    expect(saved.name).toBe("Urgent backlog");
    expect(saved.id).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-a",
        entityType: "WorkOrderSavedView",
        entityId: saved.id,
        action: "CREATED",
        beforeJson: null,
        afterJson: expect.stringContaining('"assignmentFilter":"UNASSIGNED"'),
      }),
    });
  });

  it("reconstructs only the latest active snapshot for the current user, organization and site", async () => {
    const original = snapshot();
    const updated = snapshot({ priorityFilter: "HIGH", updatedAt: "2026-08-08T11:00:00.000Z" });
    const deleted = snapshot({ id: "view-2", name: "Old", active: false });
    mocks.auditFindMany.mockResolvedValue([
      { entityId: "view-1", afterJson: JSON.stringify(original) },
      { entityId: "view-1", afterJson: JSON.stringify(updated) },
      { entityId: "view-2", afterJson: JSON.stringify(deleted) },
    ]);

    const views = await listSavedWorkOrderViews({
      userId: "user-a",
      organizationId: "org-a",
      siteId: "site-a",
    });

    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "WorkOrderSavedView",
        afterJson: {
          contains: '"userId":"user-a","organizationId":"org-a","siteId":"site-a"',
        },
      },
      orderBy: { createdAt: "asc" },
      select: { entityId: true, afterJson: true },
    });
    expect(views).toHaveLength(1);
    expect(views[0]?.priorityFilter).toBe("HIGH");
  });

  it("refuses to delete a saved view owned by another user", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify(snapshot({ userId: "user-b" })),
    });

    await expect(
      deleteSavedWorkOrderView({
        userId: "user-a",
        organizationId: "org-a",
        siteId: "site-a",
        viewId: "view-1",
      }),
    ).rejects.toMatchObject({ code: "VIEW_NOT_FOUND" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
