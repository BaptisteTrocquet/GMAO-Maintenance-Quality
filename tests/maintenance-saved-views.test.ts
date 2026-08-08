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

function snapshot(input: {
  id?: string;
  userId?: string;
  organizationId?: string;
  siteId?: string;
  surface?: "KANBAN" | "CALENDAR";
  name?: string;
  active?: boolean;
  config?: { dueFilter: "ALL" | "OVERDUE" | "DUE_7_DAYS" | "NO_DUE_DATE" } | { month: string | null };
}) {
  return {
    id: input.id ?? "view-1",
    userId: input.userId ?? "user-1",
    organizationId: input.organizationId ?? "org-a",
    siteId: input.siteId ?? "site-a",
    surface: input.surface ?? "KANBAN",
    name: input.name ?? "Overdue work",
    config: input.config ?? { dueFilter: "OVERDUE" },
    active: input.active ?? true,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

describe("maintenance saved views", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("scopes the event stream by authenticated user, organization and site", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { entityId: "view-1", afterJson: JSON.stringify(snapshot({ id: "view-1" })) },
    ]);

    const views = await listSavedMaintenanceViews({
      userId: "user-1",
      organizationId: "org-a",
      siteId: "site-a",
      surface: "KANBAN",
    });

    expect(views).toHaveLength(1);
    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "MaintenanceSavedView",
        actorId: "user-1",
        AND: [
          { afterJson: { contains: '"organizationId":"org-a"' } },
          { afterJson: { contains: '"siteId":"site-a"' } },
          { afterJson: { contains: '"userId":"user-1"' } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { entityId: true, afterJson: true },
    });
  });

  it("collapses immutable events to the latest active state", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { entityId: "view-1", afterJson: JSON.stringify(snapshot({ id: "view-1" })) },
      {
        entityId: "view-1",
        afterJson: JSON.stringify(snapshot({ id: "view-1", active: false })),
      },
      {
        entityId: "view-2",
        afterJson: JSON.stringify(snapshot({ id: "view-2", name: "Due soon" })),
      },
    ]);

    const views = await listSavedMaintenanceViews({
      userId: "user-1",
      organizationId: "org-a",
      siteId: "site-a",
    });

    expect(views.map((view) => view.id)).toEqual(["view-2"]);
  });

  it("rejects duplicate names on the same planning surface", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { entityId: "view-1", afterJson: JSON.stringify(snapshot({ name: "Overdue Work" })) },
    ]);

    await expect(
      createSavedMaintenanceView({
        userId: "user-1",
        organizationId: "org-a",
        siteId: "site-a",
        surface: "KANBAN",
        name: " overdue   work ",
        config: { dueFilter: "OVERDUE" },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_VIEW_NAME" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("records deletion as a new immutable event instead of removing history", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { entityId: "view-1", afterJson: JSON.stringify(snapshot({ id: "view-1" })) },
    ]);

    const deleted = await deleteSavedMaintenanceView({
      userId: "user-1",
      organizationId: "org-a",
      siteId: "site-a",
      viewId: "view-1",
    });

    expect(deleted.active).toBe(false);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-1",
        entityType: "MaintenanceSavedView",
        entityId: "view-1",
        action: "DELETED",
        beforeJson: expect.any(String),
        afterJson: expect.any(String),
      }),
    });
  });

  it("does not delete a snapshot belonging to another user", async () => {
    mocks.auditFindMany.mockResolvedValue([
      {
        entityId: "view-1",
        afterJson: JSON.stringify(snapshot({ id: "view-1", userId: "user-2" })),
      },
    ]);

    await expect(
      deleteSavedMaintenanceView({
        userId: "user-1",
        organizationId: "org-a",
        siteId: "site-a",
        viewId: "view-1",
      }),
    ).rejects.toMatchObject({ code: "VIEW_NOT_FOUND" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("builds stable links for Kanban and Calendar saved views", () => {
    expect(savedMaintenanceHref(snapshot({ config: { dueFilter: "DUE_7_DAYS" } }))).toBe(
      "/maintenance/kanban?due=DUE_7_DAYS",
    );
    expect(
      savedMaintenanceHref(
        snapshot({ surface: "CALENDAR", config: { month: "2026-10" } }),
      ),
    ).toBe("/maintenance/calendar?month=2026-10");
  });
});
