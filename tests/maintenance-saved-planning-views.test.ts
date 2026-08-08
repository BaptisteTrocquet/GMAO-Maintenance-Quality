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
  createSavedPlanningView,
  deleteSavedPlanningView,
  listSavedPlanningViews,
  savedPlanningViewHref,
} from "@/lib/maintenance/saved-planning-views";

function snapshot(input: {
  id: string;
  organizationId?: string;
  userId?: string;
  name?: string;
  path?: "/maintenance/kanban" | "/maintenance/calendar" | "/maintenance/workload";
  query?: string;
  active?: boolean;
}) {
  return {
    id: input.id,
    organizationId: input.organizationId ?? "org-a",
    userId: input.userId ?? "user-a",
    name: input.name ?? "My view",
    path: input.path ?? "/maintenance/kanban",
    query: input.query ?? "due=OVERDUE",
    active: input.active ?? true,
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

describe("saved planning views", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("loads only the latest active snapshots for the authenticated user and organization", async () => {
    const active = snapshot({ id: "view-a", name: "Overdue" });
    const deleted = snapshot({ id: "view-b", name: "Old", active: false });
    const foreignOrg = snapshot({ id: "view-c", organizationId: "org-b" });
    mocks.auditFindMany.mockResolvedValue([
      { entityId: "view-b", afterJson: JSON.stringify(deleted) },
      { entityId: "view-a", afterJson: JSON.stringify(active) },
      { entityId: "view-c", afterJson: JSON.stringify(foreignOrg) },
      { entityId: "view-a", afterJson: JSON.stringify({ ...active, name: "stale" }) },
    ]);

    const result = await listSavedPlanningViews({ organizationId: "org-a", userId: "user-a" });

    expect(result).toEqual([active]);
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "SavedPlanningView",
          actorId: "user-a",
          afterJson: { contains: '"organizationId":"org-a"' },
        }),
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("normalizes Kanban filters and drops tenant/site or arbitrary query parameters", async () => {
    await createSavedPlanningView({
      organizationId: "org-a",
      userId: "user-a",
      name: "  Overdue work  ",
      path: "/maintenance/kanban",
      query: "due=OVERDUE&siteId=site-b&redirect=https%3A%2F%2Fevil.example",
    });

    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-a",
        entityType: "SavedPlanningView",
        action: "CREATED",
        afterJson: expect.any(String),
      }),
    });
    const call = mocks.auditCreate.mock.calls[0]?.[0] as { data: { afterJson: string } };
    expect(JSON.parse(call.data.afterJson)).toEqual(
      expect.objectContaining({
        organizationId: "org-a",
        userId: "user-a",
        name: "Overdue work",
        path: "/maintenance/kanban",
        query: "due=OVERDUE",
        active: true,
      }),
    );
  });

  it("rejects paths outside the planning allowlist", async () => {
    await expect(
      createSavedPlanningView({
        organizationId: "org-a",
        userId: "user-a",
        name: "Unsafe",
        path: "https://evil.example",
      }),
    ).rejects.toMatchObject({ code: "INVALID_VIEW" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects deleting a view owned by another organization", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify(snapshot({ id: "view-a", organizationId: "org-b" })),
    });

    await expect(
      deleteSavedPlanningView({ organizationId: "org-a", userId: "user-a", viewId: "view-a" }),
    ).rejects.toMatchObject({ code: "VIEW_NOT_FOUND" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("soft-deletes a personal view with an immutable snapshot", async () => {
    const previous = snapshot({ id: "view-a", path: "/maintenance/calendar", query: "month=2026-08" });
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(previous) });

    const result = await deleteSavedPlanningView({
      organizationId: "org-a",
      userId: "user-a",
      viewId: "view-a",
    });

    expect(result.active).toBe(false);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-a",
        entityType: "SavedPlanningView",
        entityId: "view-a",
        action: "DELETED",
        beforeJson: JSON.stringify(previous),
      }),
    });
  });

  it("builds only relative allowlisted hrefs", () => {
    expect(
      savedPlanningViewHref({ path: "/maintenance/calendar", query: "month=2026-08" }),
    ).toBe("/maintenance/calendar?month=2026-08");
  });
});
