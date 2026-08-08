import { describe, expect, it } from "vitest";
import {
  buildWorkOrderBoard,
  buildWorkOrderBoardWhere,
  isWorkOrderOverdue,
  matchesDueFilter,
  WORK_ORDER_BOARD_LIMIT,
  type WorkOrderBoardItem,
} from "@/lib/maintenance/board";

const now = new Date("2026-08-08T12:00:00.000Z");

function item(overrides: Partial<WorkOrderBoardItem> = {}): WorkOrderBoardItem {
  return {
    id: "wo-1",
    number: "WO-001",
    title: "Synthetic work order",
    status: "PLANNED",
    priority: "NORMAL",
    dueAt: new Date("2026-08-10T12:00:00.000Z"),
    plannedStart: null,
    requestedAt: new Date("2026-08-01T12:00:00.000Z"),
    assetCode: "ASSET-001",
    assigneeName: null,
    teamName: null,
    ...overrides,
  };
}

describe("maintenance work-order board", () => {
  it("always scopes database queries to the selected organization and site", () => {
    expect(
      buildWorkOrderBoardWhere({
        organizationId: "org-a",
        siteId: "site-a",
        dueFilter: "ALL",
        now,
      }),
    ).toMatchObject({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
    });
  });

  it("uses a bounded large-list ceiling", () => {
    expect(WORK_ORDER_BOARD_LIMIT).toBe(500);
  });

  it("treats only active workflow items past due as overdue", () => {
    expect(
      isWorkOrderOverdue(item({ dueAt: new Date("2026-08-07T12:00:00.000Z") }), now),
    ).toBe(true);
    expect(
      isWorkOrderOverdue(
        item({ status: "COMPLETED", dueAt: new Date("2026-08-07T12:00:00.000Z") }),
        now,
      ),
    ).toBe(false);
    expect(
      isWorkOrderOverdue(
        item({ status: "CANCELLED", dueAt: new Date("2026-08-07T12:00:00.000Z") }),
        now,
      ),
    ).toBe(false);
  });

  it("filters due work within the next seven days without including already overdue work", () => {
    expect(
      matchesDueFilter(
        item({ dueAt: new Date("2026-08-14T12:00:00.000Z") }),
        "DUE_7_DAYS",
        now,
      ),
    ).toBe(true);
    expect(
      matchesDueFilter(
        item({ dueAt: new Date("2026-08-16T12:00:00.000Z") }),
        "DUE_7_DAYS",
        now,
      ),
    ).toBe(false);
    expect(
      matchesDueFilter(
        item({ dueAt: new Date("2026-08-07T12:00:00.000Z") }),
        "DUE_7_DAYS",
        now,
      ),
    ).toBe(false);
  });

  it("keeps no-due-date planning focused on active work", () => {
    expect(matchesDueFilter(item({ dueAt: null }), "NO_DUE_DATE", now)).toBe(true);
    expect(
      matchesDueFilter(item({ status: "COMPLETED", dueAt: null }), "NO_DUE_DATE", now),
    ).toBe(false);
    expect(
      buildWorkOrderBoardWhere({
        organizationId: "org-a",
        siteId: "site-a",
        dueFilter: "NO_DUE_DATE",
        now,
      }),
    ).toMatchObject({
      dueAt: null,
      status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
    });
  });

  it("builds status columns, hides cancelled work and orders cards by urgency", () => {
    const board = buildWorkOrderBoard({
      dueFilter: "ALL",
      now,
      workOrders: [
        item({ id: "normal", number: "WO-002", priority: "NORMAL" }),
        item({
          id: "urgent-later",
          number: "WO-003",
          priority: "URGENT",
          dueAt: new Date("2026-08-12T12:00:00.000Z"),
        }),
        item({
          id: "urgent-sooner",
          number: "WO-004",
          priority: "URGENT",
          dueAt: new Date("2026-08-09T12:00:00.000Z"),
        }),
        item({ id: "cancelled", status: "CANCELLED" }),
        item({ id: "blocked", status: "BLOCKED", priority: "HIGH" }),
      ],
    });

    expect(board.map((column) => column.status)).toEqual([
      "REQUESTED",
      "APPROVED",
      "PLANNED",
      "IN_PROGRESS",
      "BLOCKED",
      "COMPLETED",
    ]);
    expect(board.flatMap((column) => column.items).some((workOrder) => workOrder.id === "cancelled")).toBe(false);
    expect(board.find((column) => column.status === "PLANNED")?.items.map((workOrder) => workOrder.id)).toEqual([
      "urgent-sooner",
      "urgent-later",
      "normal",
    ]);
    expect(board.find((column) => column.status === "BLOCKED")?.items.map((workOrder) => workOrder.id)).toEqual([
      "blocked",
    ]);
  });

  it("applies overdue filtering before grouping", () => {
    const board = buildWorkOrderBoard({
      dueFilter: "OVERDUE",
      now,
      workOrders: [
        item({ id: "late", status: "IN_PROGRESS", dueAt: new Date("2026-08-07T12:00:00.000Z") }),
        item({ id: "future", status: "IN_PROGRESS", dueAt: new Date("2026-08-09T12:00:00.000Z") }),
        item({ id: "done-late", status: "COMPLETED", dueAt: new Date("2026-08-01T12:00:00.000Z") }),
      ],
    });

    expect(board.find((column) => column.status === "IN_PROGRESS")?.items.map((workOrder) => workOrder.id)).toEqual(["late"]);
    expect(board.find((column) => column.status === "COMPLETED")?.items).toEqual([]);
  });
});
