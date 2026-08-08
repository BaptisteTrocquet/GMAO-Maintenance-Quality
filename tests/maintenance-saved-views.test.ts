import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      findMany: mocks.auditFindMany,
      create: mocks.auditCreate,
    },
  },
}));

import {
  createSavedMaintenanceView,
  deleteSavedMaintenanceView,
  listSavedMaintenanceViews,
  savedMaintenanceHref,
} from "@/lib/maintenance/saved-views";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "view-1",
    organizationId: "org-a",
    siteId: "site-a",
    userId: "user-a",
    surface: "KANBAN",
    name: "Overdue review",
    config: { dueFilter: "OVERDUE" },
    active: true,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("maintenance saved views", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("scopes stored views by actor, organization and site before reading snapshots", async () => {
    await listSavedMaintenanceViews({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      surface: "KANBAN",
    });

    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "MaintenanceSavedView",
        actorId: "user-a",
        AND: [
          { afterJson: { contains: '"organizationId":"org-a"' } },
          { afterJson: { contains: '"siteId":"site-a"' } },
          { afterJson: { contains: '"userId":"user-a"' } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { entityId: true, afterJson: true },
    });
  });

  it("creates an immutable user-scoped Kanban snapshot", async () => {
    const created = await createSavedMaintenanceView({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      surface: "KANBAN",
      name: "  Weekly   overdue  ",
      config: { dueFilter: "OVERDUE" },
    });

    expect(created).toMatchObject({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      surface: "KANBAN",
      name: "Weekly overdue",
      config: { dueFilter: "OVERDUE" },
      active: true,
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-a",
        entityType: "MaintenanceSavedView",
        action: "CREATED",
      }),
    });
  });

  it("rejects duplicate names on the same planning surface", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { entityId: "view-1", afterJson: JSON.stringify(snapshot()) },
    ]);

    await expect(
      createSavedMaintenanceView({
        organizationId: "org-a",
        siteId: "site-a",
        userId: "user-a",
        surface: "KANBAN",
        name: "overdue REVIEW",
        config: { dueFilter: "ALL" },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_VIEW_NAME" });

    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("does not let one user delete another user's view even if a mocked row leaks through", async () => {
    mocks.auditFindMany.mockResolvedValue([
      {
        entityId: "view-other",
        afterJson: JSON.stringify(snapshot({ id: "view-other", userId: "user-b" })),
      },
    ]);

    await expect(
      deleteSavedMaintenanceView({
        organizationId: "org-a",
        siteId: "site-a",
        userId: "user-a",
        viewId: "view-other",
      }),
    ).rejects.toMatchObject({ code: "VIEW_NOT_FOUND" });

    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("builds stable links for Kanban and Calendar views", () => {
    expect(
      savedMaintenanceHref({ surface: "KANBAN", config: { dueFilter: "DUE_7_DAYS" } }),
    ).toBe("/maintenance/kanban?due=DUE_7_DAYS");
    expect(
      savedMaintenanceHref({ surface: "CALENDAR", config: { month: "2026-08" } }),
    ).toBe("/maintenance/calendar?month=2026-08");
  });
});
